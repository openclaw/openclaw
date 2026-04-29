# Nemo Android 桌宠计划

## 已完成并验证

- [x] Android 端默认进入 Nemo 桌宠界面。
- [x] 移除底部 Tab，改为左上角调试入口打开侧滑菜单。
- [x] 缩减顶部标题栏，让 Nemo 表情占据主要屏幕空间。
- [x] 实现 idle 表情动画，并区分思考、执行、说话等状态。
- [x] 增加 Nemo 快速文本输入，并发送到独立的 Nemo agent session。
- [x] 监听 gateway 的 `chat` / `agent` 事件，把 OpenClaw Agent 活动映射到 Nemo 状态。
- [x] 收到 assistant 回复后，在 Nemo 界面显示普通用户可理解的信息浮层。
- [x] 增加 Nemo agent profile 初始化入口和普通用户文案。
- [x] 为 Android buddy 核心状态、profile、输入、动画策略补充单元测试。
- [x] 使用 Android 模拟器完成文本聊天端到端验证，并保存演示录屏。
- [x] 在 Nemo 界面提供清晰的语音、摄像头、文字输入入口，避免依赖隐藏触摸区域。
- [x] 让 Nemo 语音入口留在桌宠界面内工作，而不是跳转到 Voice 页面。
- [x] 增加可测试的 buddy 输入控制策略，覆盖语音开启/关闭和麦克风权限申请。
- [x] 拍照成功后，将画面作为图片附件发送给 Nemo agent。
- [x] 完成摄像头拍照能力的端到端验证；模拟器无前置摄像头时自动回退后置摄像头。
- [x] Nemo 语音模式开启后留在桌宠界面，并展示“我在听”状态。
- [x] Nemo 回复状态优先于监听状态，界面直接显示 assistant 回复结果。
- [x] Nemo 对话超时时显示“可以再说一次”的友好提示，不再静默回到监听态。
- [x] Nemo 语音唤醒词支持 `NemoNemo`，并兼容 `Nemo Nemo`、`Memo memo`、`Neemo Neemo` 等常见识别变体。
- [x] 增加仅 debug build 生效的 Nemo 语音转写注入口，用于自动化验证唤醒词、Nemo session、回复浮层和 TTS 链路。
- [x] 恢复 Android 模拟器 adb 连接，完成 debug 语音注入录屏，确认 UI 回复浮层和本地 TTS。
- [x] 调整 TTS 音频焦点处理，避免 transient focus loss 直接打断 Nemo 语音回复。
- [x] Nemo 进入收音状态时静音系统识别提示音，只保留界面上的“我在听”状态。
- [x] Nemo 空闲收音时保持可见监听态，静音/没听清不再让界面频繁跳出监听状态。
- [x] 增加 iOS Buddy 状态模型 builder 和 Nemo 桌宠 UI 骨架。
- [x] 增加 Gateway 侧 Nemo agent profile 初始化中文引导文档。
- [x] 重跑 Android 单元测试、debug APK 构建和 iOS Buddy 解析检查。

## 待实现

- [ ] 完成 Nemo agent profile 初始化后的端到端验证，包括 Missing、Initializing、NeedsRestart、Ready 状态。
- [ ] 在真实旧 Android 手机上复测麦克风语音唤醒、前台常驻、横屏、发热和息屏策略。
