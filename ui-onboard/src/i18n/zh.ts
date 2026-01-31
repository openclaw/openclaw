/**
 * Chinese translations (简体中文)
 */

export default {
  // App
  "app.title": "OpenClaw 配置向导",
  "app.subtitle": "配置您的 AI 助手",
  "app.loading": "加载中...",
  "app.connecting": "正在连接服务器...",
  "app.connection_error": "连接失败，请刷新页面重试。",

  // Language
  "lang.en": "English",
  "lang.zh": "中文",

  // Common
  "common.next": "下一步",
  "common.back": "上一步",
  "common.skip": "跳过",
  "common.save": "保存",
  "common.cancel": "取消",
  "common.confirm": "确认",
  "common.yes": "是",
  "common.no": "否",
  "common.done": "完成",
  "common.close": "关闭",
  "common.select": "选择",
  "common.continue": "继续",
  "common.or": "或",

  // Welcome
  "welcome.title": "欢迎使用 OpenClaw",
  "welcome.subtitle": "让我们开始配置您的 AI 助手",
  "welcome.description": "本向导将帮助您逐步完成 OpenClaw 的配置。",
  "welcome.start": "开始配置",

  // Security
  "security.title": "安全提示",
  "security.warning": "安全警告 — 请仔细阅读。",
  "security.description": `OpenClaw 是一个功能强大的 AI 助手，可以：
• 读取文件并访问您的文件系统
• 如果启用工具，可以执行命令
• 响应来自已配置频道的消息

请确保您在继续之前了解安全影响。`,
  "security.recommendations": `建议的安全措施：
• 使用配对/白名单和提及限制
• 启用沙箱和最小权限工具
• 将敏感信息保存在代理无法访问的位置
• 对于启用工具的机器人，使用最强大的可用模型`,
  "security.docs": "阅读安全文档",
  "security.accept": "我了解风险，继续配置",
  "security.decline": "我需要更多时间了解",

  // Auth Provider
  "auth.title": "模型提供商",
  "auth.subtitle": "选择您的 AI 模型提供商",
  "auth.description": "选择您希望如何与 AI 模型提供商进行身份验证。",

  // Provider groups
  "auth.group.anthropic": "Anthropic",
  "auth.group.openai": "OpenAI",
  "auth.group.google": "Google",
  "auth.group.chinese": "国内服务商",
  "auth.group.aggregator": "聚合平台",
  "auth.group.other": "其他",

  // Provider options
  "auth.anthropic": "Anthropic (Claude)",
  "auth.openai": "OpenAI (GPT)",
  "auth.google": "Google (Gemini)",
  "auth.openrouter": "OpenRouter",
  "auth.siliconflow": "硅基流动 (SiliconFlow)",
  "auth.opencode": "OpenCode Zen",
  "auth.nvidia": "NVIDIA NIM",
  "auth.moonshot": "月之暗面 (Kimi)",
  "auth.minimax": "MiniMax",
  "auth.zai": "智谱 (GLM)",
  "auth.xiaomi": "小米 (MiMo)",
  "auth.venice": "Venice AI",
  "auth.synthetic": "Synthetic",
  "auth.copilot": "GitHub Copilot",

  // API Key
  "auth.api_key.title": "API 密钥",
  "auth.api_key.label": "输入您的 API 密钥",
  "auth.api_key.placeholder": "sk-...",
  "auth.api_key.hint": "您的 API 密钥将安全地存储在本地机器上。",
  "auth.api_key.get_key": "获取 API 密钥",
  "auth.api_key.invalid": "请输入有效的 API 密钥",

  // Model Selection
  "model.title": "默认模型",
  "model.subtitle": "选择您的默认 AI 模型",
  "model.description": "此模型将默认用于对话。",
  "model.filter": "按提供商筛选",
  "model.search": "搜索模型...",
  "model.free": "免费",
  "model.paid": "付费",
  "model.reasoning": "推理",

  // Gateway
  "gateway.title": "网关设置",
  "gateway.subtitle": "配置 OpenClaw 网关",
  "gateway.description": "网关处理您的频道和 AI 之间的通信。",
  "gateway.port": "端口",
  "gateway.port_hint": "默认：18789",
  "gateway.bind": "绑定模式",
  "gateway.bind.loopback": "本地回环 (127.0.0.1) - 仅本地访问",
  "gateway.bind.lan": "局域网 (0.0.0.0) - 所有接口",
  "gateway.bind.tailnet": "Tailnet - Tailscale 网络",
  "gateway.bind.auto": "自动 - 优先本地回环",
  "gateway.auth": "认证方式",
  "gateway.auth.token": "令牌",
  "gateway.auth.password": "密码",
  "gateway.token": "网关令牌",
  "gateway.token_hint": "留空将自动生成",

  // Channels
  "channels.title": "消息频道",
  "channels.subtitle": "配置消息频道",
  "channels.description": "选择您想要连接到 OpenClaw 的消息平台。",
  "channels.telegram": "Telegram",
  "channels.discord": "Discord",
  "channels.whatsapp": "WhatsApp",
  "channels.slack": "Slack",
  "channels.signal": "Signal",
  "channels.imessage": "iMessage",
  "channels.configured": "已配置",
  "channels.not_configured": "未配置",
  "channels.skip": "跳过频道设置",

  // Skills
  "skills.title": "技能",
  "skills.subtitle": "配置代理技能",
  "skills.description": "技能通过额外工具扩展代理的能力。",
  "skills.eligible": "可用技能",
  "skills.missing_deps": "缺少依赖",
  "skills.install_deps": "安装依赖",
  "skills.skip": "跳过技能设置",

  // Hooks
  "hooks.title": "钩子",
  "hooks.subtitle": "配置自动化钩子",
  "hooks.description": "钩子允许您在发出代理命令时自动执行操作。",
  "hooks.no_hooks": "没有可用的钩子。您可以稍后在配置中添加钩子。",
  "hooks.skip": "跳过钩子设置",

  // Complete
  "complete.title": "配置完成！",
  "complete.subtitle": "OpenClaw 已准备就绪",
  "complete.description": "您的配置已保存。现在可以开始使用 OpenClaw 了。",
  "complete.next_steps": "后续步骤：",
  "complete.step1": "确保网关正在运行（见上方说明）",
  "complete.step2": "访问控制面板：http://127.0.0.1:18789",
  "complete.step3": "通过已配置的频道发送消息",
  "complete.open_dashboard": "打开控制面板",
  "complete.close": "关闭向导",
  "complete.gateway_info_title": "启动网关",
  "complete.gateway_info_desc": "如果网关服务安装失败（例如权限问题），您需要手动启动它：",
  "complete.gateway_info_note": "使用 OpenClaw 时请保持此终端窗口打开。网关负责处理您的频道与 AI 之间的通信。",
  "complete.service_warning_title": "Windows 用户注意",
  "complete.service_warning_desc": "如果网关服务安装因「拒绝访问」而失败，您可以选择以管理员身份重新运行配置向导，或者每次使用 OpenClaw 时手动运行 'openclaw gateway run'。",
  "complete.shutdown_description": "配置完成后，您可以关闭向导并停止配置服务器：",
  "complete.shutdown_wizard": "关闭向导并停止服务",
  "complete.shutting_down": "正在关闭...",
  "complete.shutdown_complete": "服务已停止",
  "complete.shutdown_status": "配置服务器已停止。您可以关闭此标签页。",

  // Progress
  "progress.step": "步骤",
  "progress.of": "/",

  // Errors
  "error.title": "错误",
  "error.connection_lost": "与服务器的连接已断开",
  "error.retry": "重试",
  "error.unknown": "发生未知错误",

  // Cancelled
  "cancelled.title": "配置已取消",
  "cancelled.risk_not_accepted": "您选择不继续。准备好后可以重新开始配置。",
  "cancelled.default": "配置已取消。您可以随时重新开始。",

  // Backend message translations (for known messages)
  "backend.risk_not_accepted": "您选择不继续。准备好后可以重新开始配置。",
  "backend.wizard_cancelled": "配置已取消。",

  // Wizard-specific messages
  "wizard.confirm_risk": "我了解这很强大但存在风险。是否继续？",
  "wizard.enter_anthropic_key": "请输入您的 Anthropic API 密钥",
  "wizard.enter_openai_key": "请输入您的 OpenAI API 密钥",
  "wizard.enter_google_key": "请输入您的 Google API 密钥",
  "wizard.enter_openrouter_key": "请输入您的 OpenRouter API 密钥",
  "wizard.enter_siliconflow_key": "请输入您的硅基流动 API 密钥",
  "wizard.enter_opencode_key": "请输入您的 OpenCode Zen API 密钥",
  "wizard.enter_nvidia_key": "请输入您的 NVIDIA NIM API 密钥",
  "wizard.install_gateway": "是否将网关安装为系统服务？",
  "wizard.gateway_install_failed": "网关服务安装失败。可能需要管理员权限。",
  "wizard.config_saved": "配置保存成功！",
  "wizard.fetching_models": "正在获取可用模型...",
  "wizard.validating_key": "正在验证 API 密钥...",
  "wizard.saving_config": "正在保存配置...",
};
