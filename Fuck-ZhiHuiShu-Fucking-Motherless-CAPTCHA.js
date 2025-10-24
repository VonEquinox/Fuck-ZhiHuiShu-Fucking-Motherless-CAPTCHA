// ==UserScript==
// @name         智慧树验证码自动识别
// @version      1.1.0
// @description  自动识别并处理智慧树的点选式验证码
// @author       Your Name
// @match        *://*.zhihuishu.com/*
// @match        *://onlineweb.zhihuishu.com/*
// @match        *://onlineservice.zhihuishu.com/*
// @match        *://studyh5.zhihuishu.com/*
// @exclude      *://passport.zhihuishu.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_notification
// @connect      gateway.ai.cloudflare.com
// @run-at       document-end
// @compatible   chrome
// @compatible   firefox
// @compatible   edge
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // ===== 配置区域 =====
    const CONFIG = {
        // Cloudflare AI Gateway配置（用于图像识别）
        api: {
            url: '',
            key: '', // 你的API Key
            model: 'google-ai-studio/gemini-2.5-flash',
            timeout: 60000  // API超时时间（60秒）
        },
        // 图像处理参数
        image: {
            binaryThreshold: 210,  // 二值化阈值（与Python代码一致）
            minContourArea: 50,    // 最小轮廓面积
            sourceWidth: 480,      // 原始图片宽度
            sourceHeight: 240      // 原始图片高度
        },
        // 检测间隔
        checkInterval: 2000,       // 检测验证码的间隔（增加到2秒）
        // 调试模式
        debug: true
    };

    // 全局状态管理
    const STATE = {
        isProcessing: false,      // 是否正在处理验证码
        lastProcessTime: 0,        // 上次处理时间
        processCount: 0,           // 处理次数
        retryCount: 0,             // 当前重试次数
        maxRetries: 3              // 最大重试次数
    };

    // ===== 工具函数 =====

    // 日志输出
    function log(message, type = 'info') {
        if (!CONFIG.debug) return;
        const prefix = '[验证码助手]';
        const styles = {
            info: 'color: #2196F3',
            success: 'color: #4CAF50; font-weight: bold',
            warn: 'color: #FF9800',
            error: 'color: #F44336; font-weight: bold',
            debug: 'color: #9E9E9E'
        };
        console.log(`%c${prefix} ${message}`, styles[type] || '');
    }

    // 延迟函数
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 随机延迟
    function randomDelay(min, max) {
        return delay(Math.random() * (max - min) + min);
    }

    // ===== 图像处理模块 =====

    // 处理验证码图片 (修改版：在彩色原图上绘制)
    async function processImage(imageUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';

            img.onload = function() {
                try {
                    // 1. 创建一个用于最终输出的画布 (将保持彩色)
                    const finalCanvas = document.createElement('canvas');
                    const finalCtx = finalCanvas.getContext('2d');
                    finalCanvas.width = img.width;
                    finalCanvas.height = img.height;
                    // 在最终画布上绘制原始彩色图片
                    finalCtx.drawImage(img, 0, 0);

                    // 2. 创建一个用于图像处理的临时画布 (将变为黑白)
                    const processingCanvas = document.createElement('canvas');
                    const processingCtx = processingCanvas.getContext('2d', { willReadFrequently: true });
                    processingCanvas.width = img.width;
                    processingCanvas.height = img.height;
                    processingCtx.drawImage(img, 0, 0); // 也先画上原图

                    // 3. 关键：在【处理画布】上进行二值化
                    const imageData = processingCtx.getImageData(0, 0, processingCanvas.width, processingCanvas.height);
                    const data = imageData.data;
                    for (let i = 0; i < data.length; i += 4) {
                        const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
                        const binary = gray < CONFIG.image.binaryThreshold ? 255 : 0;
                        data[i] = binary;
                        data[i + 1] = binary;
                        data[i + 2] = binary;
                    }
                    // 将黑白数据放回处理画布
                    processingCtx.putImageData(imageData, 0, 0);

                    // 4. 关键：在【处理画布】上查找轮廓
                    const contours = findContours(processingCanvas, processingCtx);
                    log(`检测到 ${contours.length} 个字符轮廓`, 'info');

                    // 5. 关键：回到【最终的彩色画布】上，绘制轮廓和标号
                    finalCtx.strokeStyle = '#00FF00';  // 绿色边框，在彩色图上更显眼
                    finalCtx.lineWidth = 2;
                    finalCtx.fillStyle = '#FF0000';    // 红色文字
                    finalCtx.font = 'bold 20px Arial';
                    // 给文字加一点描边，防止和背景色混在一起看不清
                    finalCtx.shadowColor = 'black';
                    finalCtx.shadowBlur = 4;


                    const posArray = [];
                    contours.forEach((contour, index) => {
                        // 在彩色画布上绘制边界框
                        finalCtx.strokeRect(contour.x, contour.y, contour.width, contour.height);

                        // 在彩色画布上绘制序号
                        const labelText = (index + 1).toString();
                        const textY = contour.y >= 20 ? contour.y - 5 : contour.y + contour.height + 20;
                        finalCtx.fillText(labelText, contour.x, textY);

                        // 保存坐标（这部分逻辑不变）
                        posArray.push([
                            contour.x,
                            contour.y,
                            contour.x + contour.width,
                            contour.y + contour.height
                        ]);
                    });

                    // 6. 从【最终的彩色画布】导出带有标记的图片
                    const processedImage = finalCanvas.toDataURL('image/png');

                    resolve({
                        processedImage: processedImage,
                        posArray: posArray,
                        width: img.width,
                        height: img.height
                    });
                } catch (error) {
                    reject(error);
                }
            };

            img.onerror = () => reject(new Error('图片加载失败'));
            img.src = imageUrl;
        });
    }

    // 查找轮廓（简化版的cv2.findContours）
    function findContours(canvas, ctx) {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        const width = canvas.width;
        const height = canvas.height;
        const contours = [];
        const visited = new Array(width * height).fill(false);

        // 扫描白色区域（因为我们做了THRESH_BINARY_INV）
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const pixelIndex = y * width + x;

                // 如果是白色像素且未访问过
                if (data[idx] === 255 && !visited[pixelIndex]) {
                    const region = floodFill(data, width, height, x, y, visited);

                    if (region.area > CONFIG.image.minContourArea) {
                        contours.push({
                            x: region.minX,
                            y: region.minY,
                            width: region.maxX - region.minX,
                            height: region.maxY - region.minY
                        });
                    }
                }
            }
        }

        // 按x坐标排序（从左到右）
        contours.sort((a, b) => a.x - b.x);

        return contours;
    }

    // 洪水填充算法
    function floodFill(data, width, height, startX, startY, visited) {
        const stack = [[startX, startY]];
        let minX = startX, maxX = startX;
        let minY = startY, maxY = startY;
        let area = 0;

        while (stack.length > 0) {
            const [x, y] = stack.pop();

            if (x < 0 || x >= width || y < 0 || y >= height) continue;

            const pixelIndex = y * width + x;
            if (visited[pixelIndex]) continue;

            const idx = pixelIndex * 4;
            if (data[idx] !== 255) continue; // 不是白色像素

            visited[pixelIndex] = true;
            area++;

            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);

            // 添加8个相邻像素（包括对角线）
            stack.push([x + 1, y]);
            stack.push([x - 1, y]);
            stack.push([x, y + 1]);
            stack.push([x, y - 1]);
            stack.push([x + 1, y + 1]);
            stack.push([x - 1, y - 1]);
            stack.push([x + 1, y - 1]);
            stack.push([x - 1, y + 1]);
        }

        return { minX, maxX, minY, maxY, area };
    }

    // ===== AI识别模块 =====

    // 调用AI API获取要点击的字符索引 - 使用最基本的GM_xmlhttpRequest
    async function getIndexFromAI(processedImage, question) {
        return new Promise((resolve, reject) => {
            const base64Image = processedImage.replace(/^data:image\/(png|jpg|jpeg);base64,/, '');

            const requestData = {
                model: CONFIG.api.model,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: question + ' 你需要仔细的理解你需要找什么,一步一步的找到目标对应的序号,你只需要给出序号就可以了,不要输出其他的任何东西'
                        },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Image}`,
                                detail: 'auto'
                            }
                        }
                    ]
                }],
                temperature: 0.1,
                max_tokens: 23768
            };

            console.log('[验证码助手] 发送AI请求:', {
                url: CONFIG.api.url,
                model: CONFIG.api.model,
                question: question
            });

            GM_xmlhttpRequest({
                method: 'POST',
                url: CONFIG.api.url,
                headers: {
                    'Authorization': `Bearer ${CONFIG.api.key}`,
                    'Content-Type': 'application/json'
                },
                data: JSON.stringify(requestData),
                onload: function(response) {
                    console.log('[验证码助手] 原始响应:', response.responseText);
                    console.log('[验证码助手] 响应状态:', response.status);

                    try {
                        const data = JSON.parse(response.responseText);

                        // 处理错误响应
                        if (data.error) {
                            console.error('[验证码助手] API返回错误:', data.error);
                            reject(new Error(data.error.message || JSON.stringify(data.error)));
                            return;
                        }

                        // 处理正常响应
                        if (data.choices && data.choices[0] && data.choices[0].message) {
                            const content = data.choices[0].message.content;
                            if (!content) {
                                console.error('[验证码助手] AI未返回内容，可能是token限制问题:', data);
                                reject(new Error('AI未返回内容，请检查max_tokens设置'));
                                return;
                            }
                            const match = content.match(/\d+/);
                            if (match) {
                                resolve(parseInt(match[0]));
                            } else {
                                console.error('[验证码助手] AI返回内容中未找到数字:', content);
                                reject(new Error('未找到数字: ' + content));
                            }
                        } else {
                            console.error('[验证码助手] 响应格式异常:', data);
                            reject(new Error('响应格式异常: ' + JSON.stringify(data)));
                        }
                    } catch (e) {
                        console.error('[验证码助手] 解析响应失败:', e);
                        reject(new Error('解析响应失败: ' + e.message));
                    }
                },
                onerror: function(response) {
                    console.error('[验证码助手] 请求失败:', response);
                    reject(new Error('网络请求失败'));
                }
            });
        });
    }

    // ===== 验证码处理核心 =====

    // 检查并处理验证码
    async function checkAndHandleCaptcha() {
        // 防止重复处理
        if (STATE.isProcessing) {
            log('正在处理中，跳过本次检测', 'info');
            return false;
        }

        // 检查是否需要冷却
        const now = Date.now();
        if (now - STATE.lastProcessTime < 3000) {
            log('冷却中，跳过本次检测', 'info');
            return false;
        }

        try {
            // 检测验证码弹窗
            const modal = document.querySelector('.yidun_modal');
            if (!modal || modal.style.display === 'none' || modal.style.visibility === 'hidden') {
                STATE.retryCount = 0;  // 重置重试次数
                return false;
            }

            log('检测到验证码弹窗!', 'warn');
            STATE.isProcessing = true;
            STATE.lastProcessTime = now;
            STATE.processCount++;
            log(`开始处理验证码 (第${STATE.processCount}次)`, 'info');

            // 等待元素加载
            await delay(500);

            // 获取验证码图片
            const captchaImage = document.querySelector('.yidun_bg-img');
            if (!captchaImage) {
                log('未找到验证码图片元素', 'error');
                STATE.isProcessing = false;
                return false;
            }

            const imageUrl = captchaImage.src;
            if (!imageUrl) {
                log('无法获取验证码图片URL', 'error');
                STATE.isProcessing = false;
                return false;
            }

            log(`验证码图片URL: ${imageUrl}`, 'info');

            // 处理图片
            const processResult = await processImage(imageUrl);

            // 获取提示文字
            const instructionElement = document.querySelector('.yidun_tips__text.yidun-fallback__tip');
            if (!instructionElement) {
                log('未找到提示文字', 'error');
                STATE.isProcessing = false;
                return false;
            }

            const instruction = instructionElement.textContent;
            log(`提示: ${instruction}`, 'info');

            // 调用AI识别
            let targetIndex;
            try {
                targetIndex = await getIndexFromAI(processResult.processedImage, instruction);
                log(`AI识别结果 - 索引: ${targetIndex}`, 'success');
            } catch (apiError) {
                log(`AI API调用失败: ${apiError.message}`, 'error');
                STATE.isProcessing = false;

                // 如果API失败，等待后重试
                if (STATE.retryCount < STATE.maxRetries) {
                    STATE.retryCount++;
                    log(`将在3秒后重试 (${STATE.retryCount}/${STATE.maxRetries})`, 'warn');
                    await delay(3000);
                    return checkAndHandleCaptcha();
                } else {
                    log('达到最大重试次数，放弃处理', 'error');
                    STATE.retryCount = 0;
                    return false;
                }
            }

            if (targetIndex < 1 || targetIndex > processResult.posArray.length) {
                log(`索引超出范围: ${targetIndex}`, 'error');
                STATE.isProcessing = false;
                return false;
            }

            // 获取目标坐标（索引从1开始）
            const targetCoords = processResult.posArray[targetIndex - 1];
            const centerX = (targetCoords[0] + targetCoords[2]) / 2;
            const centerY = (targetCoords[1] + targetCoords[3]) / 2;

            // 获取实际显示的验证码容器
            const captchaContainer = captchaImage;
            if (!captchaContainer) {
                log('未找到验证码容器（IMG元素）', 'error');
                STATE.isProcessing = false;
                return false;
            }

            // 计算缩放比例
            const displayedSize = captchaContainer.getBoundingClientRect();
            // 【优化建议】使用 processImage 返回的实际图片宽高，而不是配置中的固定值，这样更健壮
            const scaleX = displayedSize.width / processResult.width;
            const scaleY = displayedSize.height / processResult.height;

            // 计算实际点击坐标
            const clickX = centerX * scaleX;
            const clickY = centerY * scaleY;

            log(`计算得到的点击偏移量: (${clickX}, ${clickY})`, 'info');

            // 执行点击
            await performClick(captchaContainer, clickX, clickY);

            // 等待验证结果
            await delay(1500);

            // 检查是否成功
            const modalStillExists = document.querySelector('.yidun_modal');
            if (modalStillExists && modalStillExists.style.display !== 'none') {
                log('验证码仍然存在，验证可能失败', 'warn');
                STATE.isProcessing = false;

                // 检查重试次数
                if (STATE.retryCount < STATE.maxRetries) {
                    STATE.retryCount++;
                    log(`将在2秒后重试 (${STATE.retryCount}/${STATE.maxRetries})`, 'warn');
                    await delay(2000);
                    return checkAndHandleCaptcha();
                } else {
                    log('达到最大重试次数，停止处理', 'error');
                    STATE.retryCount = 0;
                    return false;
                }
            } else {
                log('验证码弹窗已消失，验证成功！', 'success');
                showNotification('验证码验证成功！');
                STATE.isProcessing = false;
                STATE.retryCount = 0;
                return true;
            }

        } catch (error) {
            log(`处理验证码时出错: ${error.message}`, 'error');
            log(`错误堆栈: ${error.stack}`, 'debug');
            STATE.isProcessing = false;
            return false;
        }
    }

    // 执行点击操作
    async function performClick(element, offsetX, offsetY) {
        // 获取元素位置
        const rect = element.getBoundingClientRect();

        // 直接使用计算出的坐标，不需要额外偏移
        const targetX = offsetX;
        const targetY = offsetY;

        log(`在容器内位置 (${targetX.toFixed(2)}, ${targetY.toFixed(2)}) 执行点击`, 'info');

        // 创建鼠标事件序列
        const mouseEvents = {
            mousemove: new MouseEvent('mousemove', {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + targetX,
                clientY: rect.top + targetY
            }),
            mousedown: new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + targetX,
                clientY: rect.top + targetY,
                button: 0
            }),
            mouseup: new MouseEvent('mouseup', {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + targetX,
                clientY: rect.top + targetY,
                button: 0
            }),
            click: new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + targetX,
                clientY: rect.top + targetY
            })
        };

        // 模拟用户操作序列
        element.dispatchEvent(mouseEvents.mousemove);
        await randomDelay(200, 500);  // pause(random.uniform(0.2, 0.5))

        element.dispatchEvent(mouseEvents.mousedown);
        await randomDelay(50, 100);   // pause(random.uniform(0.05, 0.1))

        element.dispatchEvent(mouseEvents.mouseup);
        element.dispatchEvent(mouseEvents.click);

        log('已执行点击动作。', 'info');
    }

    // 显示通知
    function showNotification(message) {
        if (typeof GM_notification !== 'undefined') {
            GM_notification({
                text: message,
                title: '智慧树验证码助手',
                timeout: 3000
            });
        }
    }

    // ===== API测试功能 =====

    // 测试API连接
    async function testAPI() {
        log('开始测试API连接...', 'info');

        try {
            // 创建一个简单的测试请求
            const requestData = {
                model: CONFIG.api.model,
                messages: [{
                    role: 'user',
                    content: 'test'
                }],
                max_tokens: 1
            };

            console.log('[验证码助手] 测试API连接:', {
                url: CONFIG.api.url,
                model: CONFIG.api.model
            });

            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: CONFIG.api.url,
                    headers: {
                        'Authorization': `Bearer ${CONFIG.api.key}`,
                        'Content-Type': 'application/json'
                    },
                    data: JSON.stringify(requestData),
                    timeout: 10000,
                    onload: function(response) {
                        console.log('[验证码助手] 测试响应:', response.responseText);
                        console.log('[验证码助手] 测试状态:', response.status);

                        if (response.status === 200) {
                            try {
                                const data = JSON.parse(response.responseText);
                                if (data.choices || !data.error) {
                                    log('API连接测试成功！', 'success');
                                    resolve(true);
                                } else {
                                    log(`API测试失败: ${data.error?.message || '未知错误'}`, 'error');
                                    resolve(false);
                                }
                            } catch (e) {
                                log('API连接测试成功（响应解析警告）', 'success');
                                resolve(true);
                            }
                        } else {
                            log(`API测试失败，状态码: ${response.status}`, 'error');
                            log(`响应内容: ${response.responseText}`, 'debug');
                            resolve(false);
                        }
                    },
                    onerror: function(response) {
                        console.error('[验证码助手] 测试请求失败:', response);
                        log('API连接失败，请检查网络或API密钥', 'error');
                        resolve(false);
                    },
                    ontimeout: function() {
                        log('API连接超时', 'error');
                        resolve(false);
                    }
                });
            });
        } catch (error) {
            log(`API测试异常: ${error.message}`, 'error');
            return false;
        }
    }

    // ===== UI界面 =====

    // 添加样式
    GM_addStyle(`
        #captcha-helper-btn {
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 9999999;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 25px;
            font-size: 14px;
            font-weight: bold;
            cursor: pointer;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
            transition: all 0.3s ease;
        }

        #captcha-helper-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
        }

        #captcha-helper-btn:active {
            transform: translateY(0);
        }

        #captcha-helper-btn.processing {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            animation: pulse 1.5s infinite;
        }

        @keyframes pulse {
            0% { box-shadow: 0 4px 15px rgba(240, 147, 251, 0.4); }
            50% { box-shadow: 0 4px 25px rgba(240, 147, 251, 0.8); }
            100% { box-shadow: 0 4px 15px rgba(240, 147, 251, 0.4); }
        }

        #captcha-helper-status {
            position: fixed;
            bottom: 60px;
            right: 20px;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 8px 12px;
            border-radius: 8px;
            font-size: 12px;
            display: none;
            z-index: 9999998;
        }

        #captcha-helper-status.show {
            display: block;
        }
    `);

    // 创建悬浮按钮
    function createFloatingButton() {
        // 主按钮
        const button = document.createElement('button');
        button.id = 'captcha-helper-btn';
        button.textContent = '🤖 检测验证码';

        // 测试按钮
        const testBtn = document.createElement('button');
        testBtn.id = 'captcha-test-btn';
        testBtn.textContent = '🔧 测试API';

        // 状态显示
        const status = document.createElement('div');
        status.id = 'captcha-helper-status';

        // API配置面板
        const configPanel = document.createElement('div');
        configPanel.id = 'api-config-panel';
        configPanel.innerHTML = `
            <h3>API配置</h3>
            <label>API密钥:</label>
            <input type="text" id="api-key-input" placeholder="sk-..." value="${CONFIG.api.key}">
            <label>API地址:</label>
            <input type="text" id="api-url-input" value="${CONFIG.api.url}">
            <label>模型名称:</label>
            <input type="text" id="api-model-input" value="${CONFIG.api.model}">
            <div style="margin-top: 15px; text-align: right;">
                <button class="cancel-btn" onclick="document.getElementById('api-config-panel').classList.remove('show')">取消</button>
                <button class="save-btn" id="save-config-btn">保存</button>
            </div>
        `;

        // 主按钮事件
        button.addEventListener('click', async function() {
            if (this.classList.contains('processing')) {
                return;
            }

            this.classList.add('processing');
            this.textContent = '⏳ 处理中...';

            const result = await checkAndHandleCaptcha();

            this.classList.remove('processing');
            this.textContent = result ? '✅ 验证成功' : '❌ 未检测到';

            setTimeout(() => {
                this.textContent = '🤖 检测验证码';
            }, 3000);
        });

        // 测试按钮事件
        testBtn.addEventListener('click', async function() {
            // 长按打开配置
            let pressTimer;
            this.addEventListener('mousedown', () => {
                pressTimer = setTimeout(() => {
                    configPanel.classList.add('show');
                }, 1000);
            });

            this.addEventListener('mouseup', () => {
                clearTimeout(pressTimer);
            });

            // 单击测试API
            this.addEventListener('click', async () => {
                this.textContent = '⏳ 测试中...';
                this.disabled = true;

                const success = await testAPI();

                if (success) {
                    this.textContent = '✅ API正常';
                    this.style.background = 'linear-gradient(135deg, #56ab2f 0%, #a8e063 100%)';
                } else {
                    this.textContent = '❌ API异常';
                    this.style.background = 'linear-gradient(135deg, #f44336 0%, #ff6b6b 100%)';
                }

                this.disabled = false;

                setTimeout(() => {
                    this.textContent = '🔧 测试API';
                    this.style.background = '';
                }, 3000);
            });
        });

        // 保存配置按钮事件
        if (configPanel.querySelector('#save-config-btn')) {
            configPanel.querySelector('#save-config-btn').addEventListener('click', () => {
                CONFIG.api.key = document.getElementById('api-key-input').value;
                CONFIG.api.url = document.getElementById('api-url-input').value;
                CONFIG.api.model = document.getElementById('api-model-input').value;

                // 保存到本地存储
                if (typeof GM_setValue !== 'undefined') {
                    GM_setValue('api_key', CONFIG.api.key);
                    GM_setValue('api_url', CONFIG.api.url);
                    GM_setValue('api_model', CONFIG.api.model);
                }

                log('API配置已保存', 'success');
                configPanel.classList.remove('show');
            });
        }

        document.body.appendChild(button);
        document.body.appendChild(testBtn);
        document.body.appendChild(status);
        document.body.appendChild(configPanel);

        // 显示状态信息
        setInterval(() => {
            if (STATE.isProcessing) {
                status.textContent = `处理中... (重试: ${STATE.retryCount}/${STATE.maxRetries})`;
                status.classList.add('show');
            } else {
                status.classList.remove('show');
            }
        }, 500);
    }

    // ===== 主程序 =====

    // 初始化
    async function init() {
        log('智慧树验证码自动识别脚本启动', 'success');
        log(`版本: 1.1.0 | 调试模式: ${CONFIG.debug ? '开启' : '关闭'}`, 'info');

        // 加载保存的配置
        if (typeof GM_getValue !== 'undefined') {
            const savedKey = GM_getValue('api_key');
            const savedUrl = GM_getValue('api_url');
            const savedModel = GM_getValue('api_model');

            if (savedKey) CONFIG.api.key = savedKey;
            if (savedUrl) CONFIG.api.url = savedUrl;
            if (savedModel) CONFIG.api.model = savedModel;
        }

        // 创建UI
        createFloatingButton();

        // 启动时测试API
        log('正在测试API连接...', 'info');
        const apiOk = await testAPI();
        if (!apiOk) {
            log('⚠️ API连接失败，请点击"测试API"按钮检查配置', 'warn');
            log('💡 提示：长按"测试API"按钮可以打开配置面板', 'info');
        }

        // 自动检测验证码
        setInterval(async () => {
            // 只在没有处理中的情况下检测
            if (!STATE.isProcessing) {
                const modal = document.querySelector('.yidun_modal');
                if (modal && modal.style.display !== 'none') {
                    log('自动检测到验证码', 'info');
                    await checkAndHandleCaptcha();
                }
            }
        }, CONFIG.checkInterval);
    }

    // 等待页面加载完成后启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }


})();

