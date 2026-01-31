/**
 * Backend message translation mapping.
 * Maps known backend messages (English) to i18n keys.
 */

import { t, getLocale } from "./index.js";

/**
 * Known backend message patterns and their translation keys.
 * Uses regex patterns for flexible matching.
 */
const MESSAGE_PATTERNS: Array<{
  pattern: RegExp | string;
  key: string;
  extract?: (match: RegExpMatchArray) => Record<string, string>;
}> = [
  // Security and intro
  { pattern: /^Security$/i, key: "security.title" },
  { pattern: /^Security warning/i, key: "security.warning" },
  { pattern: /^I understand this is powerful/i, key: "wizard.confirm_risk" },
  
  // Welcome/Intro
  { pattern: /OpenClaw Onboarding/i, key: "welcome.title" },
  { pattern: /Welcome to OpenClaw/i, key: "welcome.title" },
  
  // Auth choices
  { pattern: /How would you like to authenticate/i, key: "auth.subtitle" },
  { pattern: /Choose your authentication method/i, key: "auth.subtitle" },
  { pattern: /Select.*provider/i, key: "auth.subtitle" },
  
  // API key prompts
  { pattern: /Enter your.*API key/i, key: "auth.api_key.label" },
  { pattern: /Enter your Anthropic API key/i, key: "wizard.enter_anthropic_key" },
  { pattern: /Enter your OpenAI API key/i, key: "wizard.enter_openai_key" },
  { pattern: /Enter your Google API key/i, key: "wizard.enter_google_key" },
  { pattern: /Enter your OpenRouter API key/i, key: "wizard.enter_openrouter_key" },
  { pattern: /Enter your SiliconFlow API key/i, key: "wizard.enter_siliconflow_key" },
  { pattern: /Enter your OpenCode.*API key/i, key: "wizard.enter_opencode_key" },
  { pattern: /Enter your NVIDIA.*API key/i, key: "wizard.enter_nvidia_key" },
  
  // Model selection
  { pattern: /Select.*default model/i, key: "model.subtitle" },
  { pattern: /Choose.*model/i, key: "model.subtitle" },
  { pattern: /Which model would you like/i, key: "model.subtitle" },
  
  // Gateway
  { pattern: /Configure.*gateway/i, key: "gateway.subtitle" },
  { pattern: /Gateway.*settings/i, key: "gateway.title" },
  { pattern: /Install.*gateway.*service/i, key: "wizard.install_gateway" },
  { pattern: /Gateway service install failed/i, key: "wizard.gateway_install_failed" },
  
  // Channels
  { pattern: /Configure.*channels/i, key: "channels.subtitle" },
  { pattern: /Select.*channels/i, key: "channels.subtitle" },
  
  // Complete
  { pattern: /Onboarding complete/i, key: "complete.title" },
  { pattern: /Setup complete/i, key: "complete.title" },
  { pattern: /Configuration saved/i, key: "wizard.config_saved" },
  
  // Errors
  { pattern: /risk not accepted/i, key: "cancelled.risk_not_accepted" },
  { pattern: /wizard cancelled/i, key: "cancelled.default" },
  { pattern: /Connection.*failed/i, key: "error.connection_lost" },
];

/**
 * Simple message translations for shorter text.
 */
const SIMPLE_TRANSLATIONS: Record<string, string> = {
  // Config handling
  "Existing config detected": "检测到现有配置",
  "Config handling": "配置处理",
  "Use existing values": "使用现有值",
  "Update values": "更新值",
  "Reset": "重置",
  "Reset to defaults": "重置为默认值",
  "Merge with existing": "与现有配置合并",
  "Overwrite": "覆盖",
  
  // Setup flow
  "QuickStart": "快速开始",
  "Quick Start": "快速开始",
  "Full Setup": "完整配置",
  "Minimal Setup": "最小配置",
  "Setup type": "配置类型",
  "Setup mode": "配置模式",
  "Onboarding flow": "引导流程",
  "Select setup type": "选择配置类型",
  
  // Model/Provider
  "Model/auth provider": "模型/认证提供商",
  "Model configured": "模型已配置",
  "Default model": "默认模型",
  "Filter models by provider": "按提供商筛选模型",
  "All providers": "所有提供商",
  "Keep current": "保持当前",
  "Enter model manually": "手动输入模型",
  "Model check": "模型检查",
  "Model selection": "模型选择",
  "Select model": "选择模型",
  "Select default model": "选择默认模型",
  "Choose model": "选择模型",
  "models": "个模型",
  "Model not found": "未找到模型",
  "Model validation": "模型验证",
  "Validating model": "验证模型中",
  "Model validated": "模型验证成功",
  "Invalid model": "无效的模型",
  
  // API Key prompts
  "Enter SiliconFlow API key": "请输入硅基流动 API 密钥",
  "Enter OpenCode Zen API key": "请输入 OpenCode Zen API 密钥",
  "Enter Anthropic API key": "请输入 Anthropic API 密钥",
  "Enter OpenAI API key": "请输入 OpenAI API 密钥",
  "Enter Google API key": "请输入 Google API 密钥",
  "Enter OpenRouter API key": "请输入 OpenRouter API 密钥",
  "Enter NVIDIA NIM API key": "请输入 NVIDIA NIM API 密钥",
  "Enter Moonshot API key": "请输入月之暗面 API 密钥",
  "Enter MiniMax API key": "请输入 MiniMax API 密钥",
  "Enter Qwen API key": "请输入通义千问 API 密钥",
  "Enter DeepSeek API key": "请输入 DeepSeek API 密钥",
  "Enter API key": "请输入 API 密钥",
  "API key saved": "API 密钥已保存",
  "API key validated": "API 密钥验证成功",
  "Invalid API key": "无效的 API 密钥",
  "Validating API key": "验证 API 密钥中",
  "Fetching models": "获取模型中",
  "Fetching available models": "获取可用模型中",
  
  // Channel status
  "Channel status": "频道状态",
  "How channels work": "频道工作原理",
  "configured": "已配置",
  "not configured": "未配置",
  "install plugin to enable": "安装插件以启用",
  
  // Gateway
  "Gateway settings": "网关设置",
  "Gateway": "网关",
  "Gateway configuration": "网关配置",
  "Gateway port": "网关端口",
  "Gateway bind": "网关绑定",
  "Gateway mode": "网关模式",
  "Gateway token": "网关令牌",
  "Gateway service": "网关服务",
  "Install gateway service": "安装网关服务",
  "Gateway service installed": "网关服务已安装",
  "Start gateway": "启动网关",
  "Stop gateway": "停止网关",
  "Restart gateway": "重启网关",
  "Gateway running": "网关运行中",
  "Gateway stopped": "网关已停止",
  "Port": "端口",
  "Bind": "绑定",
  "Token": "令牌",
  
  // Common actions
  "Back": "返回",
  "返回": "返回",
  "Skip": "跳过",
  "Continue": "继续",
  "Cancel": "取消",
  "Yes": "是",
  "No": "否",
  "Confirm": "确认",
  "Done": "完成",
  "Close": "关闭",
  "Save": "保存",
  "Next": "下一步",
  "Previous": "上一步",
  "Finish": "完成",
  "Submit": "提交",
  "Apply": "应用",
  "OK": "确定",
  "Retry": "重试",
  "Refresh": "刷新",
  
  // Status
  "reasoning": "推理",
  "ctx": "上下文",
  "alias": "别名",
  "current": "当前",
  "not in catalog": "不在目录中",
  "(recommended)": "(推荐)",
  "recommended": "推荐",
  "(multi-model)": "(多模型)",
  "multi-model": "多模型",
  "available": "可用",
  "unavailable": "不可用",
  "enabled": "已启用",
  "disabled": "已禁用",
  "active": "活动",
  "inactive": "非活动",
  "connected": "已连接",
  "disconnected": "已断开",
  "loading": "加载中",
  "error": "错误",
  "success": "成功",
  "failed": "失败",
  "pending": "待处理",
  "complete": "完成",
  "incomplete": "未完成",
  "required": "必填",
  "optional": "可选",
  "default": "默认",
  "custom": "自定义",
  "free": "免费",
  "paid": "付费",
  "premium": "高级",
  "beta": "测试版",
  "experimental": "实验性",
  "deprecated": "已弃用",
  "new": "新",
  "updated": "已更新",
  
  // Providers
  "OpenAI": "OpenAI",
  "Anthropic": "Anthropic",
  "Google": "Google",
  "MiniMax": "MiniMax",
  "Moonshot AI": "月之暗面",
  "Moonshot": "月之暗面",
  "OpenRouter": "OpenRouter",
  "Qwen": "通义千问",
  "SiliconFlow 硅基流动": "硅基流动 SiliconFlow",
  "SiliconFlow": "硅基流动",
  "硅基流动": "硅基流动",
  "DeepSeek": "DeepSeek",
  "Zhipu": "智谱",
  "GLM": "GLM",
  "Baichuan": "百川",
  "Yi": "零一万物",
  "NVIDIA": "NVIDIA",
  "NVIDIA NIM": "NVIDIA NIM",
  "Azure": "Azure",
  "Amazon Bedrock": "Amazon Bedrock",
  "Cerebras": "Cerebras",
  "Groq": "Groq",
  "Together": "Together",
  "Fireworks": "Fireworks",
  "Replicate": "Replicate",
  "Perplexity": "Perplexity",
  "Mistral": "Mistral",
  "Cohere": "Cohere",
  
  // Auth methods
  "Codex OAuth + API key": "Codex OAuth + API 密钥",
  "setup-token + API key": "设置令牌 + API 密钥",
  "M2.1 (recommended)": "M2.1 (推荐)",
  "Kimi K2 + Kimi Coding": "Kimi K2 + Kimi 编程",
  "Gemini API key + OAuth": "Gemini API 密钥 + OAuth",
  "API key": "API 密钥",
  "OAuth": "OAuth 授权",
  "OAuth login": "OAuth 登录",
  "API Key": "API 密钥",
  "Bearer token": "Bearer 令牌",
  "Access token": "访问令牌",
  "Secret key": "密钥",
  "auth method": "认证方式",
  "Authentication": "认证",
  "Authorization": "授权",
  
  // Notes
  "workspace": "工作空间",
  "model": "模型",
  "gateway.mode": "网关模式",
  "gateway.port": "网关端口",
  "gateway.bind": "网关绑定",
  "skills.nodeManager": "技能管理器",
  
  // Skills
  "Skills": "技能",
  "Skills configuration": "技能配置",
  "Available skills": "可用技能",
  "Enabled skills": "已启用技能",
  "Disabled skills": "已禁用技能",
  "Install skill": "安装技能",
  "Remove skill": "移除技能",
  "Skill installed": "技能已安装",
  "Skill removed": "技能已移除",
  "No skills available": "没有可用技能",
  "Missing dependencies": "缺少依赖",
  "Install dependencies": "安装依赖",
  
  // Hooks
  "Hooks": "钩子",
  "Hooks configuration": "钩子配置",
  "Available hooks": "可用钩子",
  "No hooks available": "没有可用钩子",
  "Add hook": "添加钩子",
  "Remove hook": "移除钩子",
  
  // Channels
  "Channels": "频道",
  "Channels configuration": "频道配置",
  "Configure channels": "配置频道",
  "Channel setup": "频道设置",
  "Add channel": "添加频道",
  "Remove channel": "移除频道",
  "Channel added": "频道已添加",
  "Channel removed": "频道已移除",
  
  // Security
  "Security": "安全",
  "Security settings": "安全设置",
  "Security warning": "安全警告",
  "Security notice": "安全提示",
  
  // Configuration
  "Configuration": "配置",
  "Configuration saved": "配置已保存",
  "Configuration loaded": "配置已加载",
  "Configuration error": "配置错误",
  "Save configuration": "保存配置",
  "Load configuration": "加载配置",
  "Export configuration": "导出配置",
  "Import configuration": "导入配置",
  
  // Completion messages
  "Setup complete": "配置完成",
  "Onboarding complete": "引导完成",
  "Configuration complete": "配置完成",
  "All done": "全部完成",
  "Successfully configured": "配置成功",
  
  // Channel names
  "Telegram": "Telegram",
  "WhatsApp": "WhatsApp",
  "Discord": "Discord",
  "Slack": "Slack",
  "Signal": "Signal",
  "iMessage": "iMessage",
  "Google Chat": "Google Chat",
  "Nostr": "Nostr",
  "Microsoft Teams": "Microsoft Teams",
  "Mattermost": "Mattermost",
  "Nextcloud Talk": "Nextcloud Talk",
  "Matrix": "Matrix",
  "BlueBubbles": "BlueBubbles",
  "LINE": "LINE",
  "Zalo": "Zalo",
  "Zalo Personal": "Zalo 个人版",
  "Tlon": "Tlon",
  
  // More config
  "local": "本地",
  "loopback": "本地回环",
  "npm": "npm",
  "网关设置": "网关设置",
};

/**
 * Long text translations for channel descriptions and other multi-line content.
 */
const LONG_TEXT_TRANSLATIONS: Record<string, string> = {
  // Channel work description - translate key phrases
  "DM security: default is pairing": "私信安全：默认使用配对",
  "unknown DMs get a pairing code": "未知私信会获得配对码",
  "Approve with: openclaw pairing approve": "批准命令：openclaw pairing approve",
  "Public DMs require": "公开私信需要",
  "Multi-user DMs: set session.dmScope": "多用户私信：设置 session.dmScope",
  "to isolate sessions": "以隔离会话",
  "Docs:": "文档：",
  
  // Channel descriptions
  "simplest way to get started": "最简单的开始方式",
  "register a bot with @BotFather and get going": "通过 @BotFather 注册机器人即可使用",
  "works with your own number": "使用您自己的号码",
  "recommend a separate phone + eSIM": "建议使用单独的手机 + eSIM",
  "very well supported right now": "目前支持非常好",
  "Google Workspace Chat app with HTTP webhook": "通过 HTTP webhook 使用 Google Workspace Chat 应用",
  "supported (Socket Mode)": "已支持 (Socket 模式)",
  "signal-cli linked device": "signal-cli 链接设备",
  "more setup": "需要更多设置",
  "this is still a work in progress": "仍在开发中",
  "Decentralized protocol": "去中心化协议",
  "encrypted DMs via NIP-04": "通过 NIP-04 加密私信",
  "Bot Framework": "Bot Framework",
  "enterprise support": "企业支持",
  "self-hosted Slack-style chat": "自托管的 Slack 风格聊天",
  "install the plugin to enable": "安装插件以启用",
  "Self-hosted chat via": "通过自托管聊天",
  "webhook bots": "webhook 机器人",
  "open protocol": "开放协议",
  "iMessage via the BlueBubbles mac app + REST API": "通过 BlueBubbles Mac 应用 + REST API 使用 iMessage",
  "LINE Messaging API bot": "LINE 消息 API 机器人",
  "Japan/Taiwan/Thailand markets": "日本/台湾/泰国市场",
  "Vietnam-focused messaging platform": "越南主流消息平台",
  "Bot API": "Bot API",
  "personal account via QR code login": "通过二维码登录的个人账户",
  "decentralized messaging on Urbit": "Urbit 上的去中心化消息",
};

/**
 * Full message translations for longer text blocks.
 * These are direct replacements, not pattern matches.
 */
const FULL_MESSAGE_TRANSLATIONS: Record<string, { en: string; zh: string }> = {
  // Security note content
  "security_note": {
    en: `Security warning — please read.

OpenClaw is a hobby project and still in beta. Expect sharp edges.
This bot can read files and run actions if tools are enabled.
A bad prompt can trick it into doing unsafe things.

If you're not comfortable with basic security and access control, don't run OpenClaw.
Ask someone experienced to help before enabling tools or exposing it to the internet.

Recommended baseline:
- Pairing/allowlists + mention gating.
- Sandbox + least-privilege tools.
- Keep secrets out of the agent's reachable filesystem.
- Use the strongest available model for any bot with tools or untrusted inboxes.

Run regularly:
openclaw security audit --deep
openclaw security audit --fix

Must read: https://docs.openclaw.ai/gateway/security`,

    zh: `安全警告 — 请仔细阅读。

OpenClaw 是一个业余项目，仍处于测试阶段。可能存在问题。
如果启用工具，此机器人可以读取文件和执行操作。
恶意提示可能会诱使它执行不安全的操作。

如果您不熟悉基本的安全和访问控制，请不要运行 OpenClaw。
在启用工具或将其暴露到互联网之前，请寻求有经验的人帮助。

建议的安全基线：
- 配对/白名单 + 提及限制。
- 沙箱 + 最小权限工具。
- 将敏感信息保存在代理无法访问的位置。
- 对于启用工具或不受信任收件箱的机器人，使用最强大的可用模型。

定期运行：
openclaw security audit --deep
openclaw security audit --fix

必读文档：https://docs.openclaw.ai/gateway/security`,
  },

  // Confirm risk message
  "confirm_risk": {
    en: "I understand this is powerful and inherently risky. Continue?",
    zh: "我了解这很强大但存在风险。是否继续？",
  },

  // Gateway service messages
  "gateway_install": {
    en: "Would you like to install the gateway as a system service?",
    zh: "您想将网关安装为系统服务吗？",
  },

  "gateway_install_failed": {
    en: "Gateway service installation failed. You may need administrator privileges.",
    zh: "网关服务安装失败。您可能需要管理员权限。",
  },

  // Config saved
  "config_saved": {
    en: "Configuration saved successfully!",
    zh: "配置保存成功！",
  },
};

/**
 * Translate a backend message to the current locale.
 * Returns the original message if no translation is found.
 */
export function translateBackendMessage(message: string): string {
  if (!message) return message;

  const locale = getLocale();
  const trimmedMessage = message.trim();

  // If not Chinese locale, return original
  if (locale !== "zh") {
    return message;
  }

  // Check for exact simple translation match first
  if (SIMPLE_TRANSLATIONS[trimmedMessage]) {
    return SIMPLE_TRANSLATIONS[trimmedMessage];
  }

  // Check for known security note content
  if (trimmedMessage.includes("Security warning — please read") ||
      trimmedMessage.includes("OpenClaw is a hobby project")) {
    const securityNote = FULL_MESSAGE_TRANSLATIONS["security_note"];
    return securityNote.zh;
  }

  // Check for confirm risk message
  if (trimmedMessage.includes("powerful and inherently risky")) {
    const confirmRisk = FULL_MESSAGE_TRANSLATIONS["confirm_risk"];
    return confirmRisk.zh;
  }

  // Check for gateway install failed
  if (trimmedMessage.includes("Gateway service install failed") ||
      trimmedMessage.includes("schtasks create failed")) {
    const gatewayFailed = FULL_MESSAGE_TRANSLATIONS["gateway_install_failed"];
    return gatewayFailed.zh;
  }

  // Check for "Default model set to X" pattern
  if (trimmedMessage.startsWith("Default model set to")) {
    const modelName = trimmedMessage.replace("Default model set to ", "");
    return `默认模型已设置为 ${modelName}`;
  }

  // Check for "Model not found" pattern
  if (trimmedMessage.includes("Model not found:")) {
    return trimmedMessage
      .replace("Model not found:", "未找到模型:")
      .replace("Update agents.defaults.model or run /models list.", "请更新 agents.defaults.model 或运行 /models list。");
  }

  // Check for "X models" pattern
  const modelsMatch = trimmedMessage.match(/^(\d+)\s+models?$/i);
  if (modelsMatch) {
    return `${modelsMatch[1]} 个模型`;
  }

  // Try to translate parts of the message
  let result = trimmedMessage;
  
  // Translate channel status patterns
  result = result.replace(/: configured$/gm, ": 已配置");
  result = result.replace(/: not configured$/gm, ": 未配置");
  result = result.replace(/: install plugin to enable$/gm, ": 安装插件以启用");
  
  // Translate long text phrases
  for (const [en, zh] of Object.entries(LONG_TEXT_TRANSLATIONS)) {
    result = result.split(en).join(zh);
  }
  
  // Translate common channel descriptions
  result = result.replace(/Telegram: simplest way to get started/g, "Telegram: 最简单的开始方式");
  result = result.replace(/register a bot with @BotFather and get going/g, "通过 @BotFather 注册机器人即可使用");
  result = result.replace(/WhatsApp: works with your own number/g, "WhatsApp: 使用您自己的号码");
  result = result.replace(/recommend a separate phone \+ eSIM/g, "建议使用单独的手机 + eSIM");
  result = result.replace(/Discord: very well supported right now/g, "Discord: 目前支持非常好");
  result = result.replace(/Slack: supported \(Socket Mode\)/g, "Slack: 已支持 (Socket 模式)");
  result = result.replace(/Signal: signal-cli linked device/g, "Signal: signal-cli 链接设备");
  result = result.replace(/more setup \(David Reagans: "Hop on Discord\."\)/g, "需要更多设置");
  result = result.replace(/iMessage: this is still a work in progress/g, "iMessage: 仍在开发中");
  result = result.replace(/Nostr: Decentralized protocol/g, "Nostr: 去中心化协议");
  result = result.replace(/encrypted DMs via NIP-04/g, "通过 NIP-04 加密私信");
  result = result.replace(/Microsoft Teams: Bot Framework/g, "Microsoft Teams: Bot Framework");
  result = result.replace(/enterprise support/g, "企业支持");
  result = result.replace(/Mattermost: self-hosted Slack-style chat/g, "Mattermost: 自托管的 Slack 风格聊天");
  result = result.replace(/install the plugin to enable/g, "安装插件以启用");
  result = result.replace(/Nextcloud Talk: Self-hosted chat via Nextcloud Talk webhook bots/g, 
    "Nextcloud Talk: 通过 Nextcloud Talk webhook 机器人的自托管聊天");
  result = result.replace(/Matrix: open protocol/g, "Matrix: 开放协议");
  result = result.replace(/BlueBubbles: iMessage via the BlueBubbles mac app \+ REST API/g, 
    "BlueBubbles: 通过 BlueBubbles Mac 应用 + REST API 使用 iMessage");
  result = result.replace(/LINE: LINE Messaging API bot for Japan\/Taiwan\/Thailand markets/g, 
    "LINE: 用于日本/台湾/泰国市场的 LINE 消息 API 机器人");
  result = result.replace(/Zalo: Vietnam-focused messaging platform with Bot API/g, 
    "Zalo: 越南主流消息平台，使用 Bot API");
  result = result.replace(/Zalo Personal: Zalo personal account via QR code login/g, 
    "Zalo 个人版: 通过二维码登录的 Zalo 个人账户");
  result = result.replace(/Tlon: decentralized messaging on Urbit/g, 
    "Tlon: Urbit 上的去中心化消息");
  result = result.replace(/Google Chat: Google Workspace Chat app with HTTP webhook/g,
    "Google Chat: 通过 HTTP webhook 使用 Google Workspace Chat 应用");

  // Translate DM security section
  result = result.replace(/DM security: default is pairing; unknown DMs get a pairing code\./g,
    "私信安全：默认使用配对；未知私信会获得配对码。");
  result = result.replace(/Approve with: openclaw pairing approve <channel> <code>/g,
    "批准命令：openclaw pairing approve <channel> <code>");
  result = result.replace(/Public DMs require dmPolicy="open" \+ allowFrom=\["\*"\]\./g,
    "公开私信需要 dmPolicy=\"open\" + allowFrom=[\"*\"]。");
  result = result.replace(/Multi-user DMs: set session\.dmScope="per-channel-peer"/g,
    "多用户私信：设置 session.dmScope=\"per-channel-peer\"");
  result = result.replace(/\(or "per-account-channel-peer" for multi-account channels\) to isolate sessions\./g,
    "(或多账户频道使用 \"per-account-channel-peer\") 以隔离会话。");

  // Then, try pattern matching
  for (const { pattern, key } of MESSAGE_PATTERNS) {
    const regex = typeof pattern === "string" ? new RegExp(pattern, "i") : pattern;
    if (regex.test(trimmedMessage)) {
      const translated = t(key);
      // If translation exists and is different from the key, use it
      if (translated && translated !== key) {
        return translated;
      }
    }
  }

  return result;
}

/**
 * Translate option labels in select/multiselect prompts.
 */
export function translateOptionLabel(label: string): string {
  if (!label) return label;

  const locale = getLocale();
  if (locale !== "zh") return label;

  // Direct label translations
  const labelTranslations: Record<string, string> = {
    // Config handling
    "Use existing values": "使用现有值",
    "Update values": "更新值",
    "Reset": "重置",
    "Reset to defaults": "重置为默认值",
    "Merge": "合并",
    "Overwrite": "覆盖",
    
    // Provider labels
    "Anthropic API Key": "Anthropic API 密钥",
    "OpenAI API Key": "OpenAI API 密钥",
    "Google API Key": "Google API 密钥",
    "OpenRouter API Key": "OpenRouter API 密钥",
    "SiliconFlow API Key": "硅基流动 API 密钥",
    "OpenCode Zen API Key": "OpenCode Zen API 密钥",
    "NVIDIA NIM API Key": "NVIDIA NIM API 密钥",
    "Moonshot API Key": "月之暗面 API 密钥",
    "MiniMax API Key": "MiniMax API 密钥",
    "DeepSeek API Key": "DeepSeek API 密钥",
    "Qwen API Key": "通义千问 API 密钥",
    "GitHub Copilot": "GitHub Copilot",
    "Venice AI": "Venice AI",
    "Synthetic (test mode)": "模拟模式（测试）",
    "Synthetic": "模拟模式",
    
    // Flow labels
    "Quick start": "快速开始",
    "QuickStart": "快速开始",
    "Full setup": "完整配置",
    "Full Setup": "完整配置",
    "Minimal setup": "最小配置",
    "Minimal Setup": "最小配置",
    "Custom": "自定义",
    "Advanced": "高级",
    
    // Yes/No
    "Yes": "是",
    "No": "否",
    "Skip": "跳过",
    "Continue": "继续",
    "Back": "返回",
    "返回": "返回",
    "Cancel": "取消",
    "Confirm": "确认",
    "Done": "完成",
    "Close": "关闭",
    "Save": "保存",
    "Next": "下一步",
    "Finish": "完成",
    "OK": "确定",
    "Retry": "重试",
    
    // Model labels
    "Use recommended model": "使用推荐模型",
    "Choose a different model": "选择其他模型",
    "Free models": "免费模型",
    "Paid models": "付费模型",
    "Keep current": "保持当前",
    "Enter model manually": "手动输入模型",
    "All providers": "所有提供商",
    "Select model": "选择模型",
    "Default model": "默认模型",
    
    // Gateway labels
    "Install as service": "安装为服务",
    "Run manually": "手动运行",
    "Loopback only": "仅本地回环",
    "All interfaces": "所有接口",
    "Local only": "仅本地",
    "LAN": "局域网",
    "Tailnet": "Tailnet",
    "Auto": "自动",
    
    // Provider names (if used as labels)
    "OpenAI": "OpenAI",
    "Anthropic": "Anthropic",
    "Google": "Google",
    "MiniMax": "MiniMax",
    "Moonshot AI": "月之暗面",
    "Moonshot": "月之暗面",
    "OpenRouter": "OpenRouter",
    "Qwen": "通义千问",
    "SiliconFlow": "硅基流动",
    "DeepSeek": "DeepSeek",
    "NVIDIA": "NVIDIA",
    "NVIDIA NIM": "NVIDIA NIM",
    "Azure OpenAI": "Azure OpenAI",
    "Amazon Bedrock": "Amazon Bedrock",
    
    // Channel labels
    "Telegram": "Telegram",
    "WhatsApp": "WhatsApp",
    "Discord": "Discord",
    "Slack": "Slack",
    "Signal": "Signal",
    "iMessage": "iMessage",
    "Matrix": "Matrix",
    "Microsoft Teams": "Microsoft Teams",
    
    // Skills/Hooks
    "Enable": "启用",
    "Disable": "禁用",
    "Install": "安装",
    "Uninstall": "卸载",
    "Configure": "配置",
  };

  // Check exact match first
  if (labelTranslations[label]) {
    return labelTranslations[label];
  }

  // Check for "Keep current (model)" pattern
  if (label.startsWith("Keep current (")) {
    const modelPart = label.slice("Keep current (".length, -1);
    return `保持当前 (${modelPart})`;
  }

  // Check for "X models" pattern in labels
  const modelsMatch = label.match(/^(\d+)\s+models?$/i);
  if (modelsMatch) {
    return `${modelsMatch[1]} 个模型`;
  }

  return label;
}

/**
 * Translate hint text.
 */
export function translateHint(hint: string): string {
  if (!hint) return hint;

  const locale = getLocale();
  if (locale !== "zh") return hint;

  const hintTranslations: Record<string, string> = {
    // General hints
    "Recommended for most users": "推荐大多数用户使用",
    "Best for getting started quickly": "适合快速入门",
    "Configure all options": "配置所有选项",
    "Advanced users only": "仅限高级用户",
    "Free tier available": "有免费额度",
    "Requires API key": "需要 API 密钥",
    "Most capable model": "最强大的模型",
    "Fast and affordable": "快速且实惠",
    "Best for coding": "最适合编程",
    "(recommended)": "(推荐)",
    "recommended": "推荐",
    "Default option": "默认选项",
    "Popular choice": "热门选择",
    "New": "新",
    "Beta": "测试版",
    "Experimental": "实验性",
    "Deprecated": "已弃用",
    "Coming soon": "即将推出",
    "Limited availability": "限量供应",
    "High performance": "高性能",
    "Low latency": "低延迟",
    "Cost effective": "性价比高",
    "Enterprise grade": "企业级",
    "Open source": "开源",
    
    // Provider hints
    "Codex OAuth + API key": "Codex OAuth + API 密钥",
    "setup-token + API key": "设置令牌 + API 密钥",
    "M2.1 (recommended)": "M2.1 (推荐)",
    "Kimi K2 + Kimi Coding": "Kimi K2 + Kimi 编程",
    "Gemini API key + OAuth": "Gemini API 密钥 + OAuth",
    "API key": "API 密钥",
    "OAuth": "OAuth 授权",
    "Claude models": "Claude 模型",
    "GPT models": "GPT 模型",
    "Gemini models": "Gemini 模型",
    "Multiple providers": "多个提供商",
    "Chinese models": "国产模型",
    "Open models": "开源模型",
    
    // Model hints
    "reasoning": "推理",
    "current (not in catalog)": "当前 (不在目录中)",
    "current": "当前",
    "not in catalog": "不在目录中",
    "vision": "视觉",
    "multimodal": "多模态",
    "text only": "仅文本",
    "long context": "长上下文",
    "fast": "快速",
    "slow": "较慢",
    "expensive": "较贵",
    "cheap": "便宜",
    
    // Model info patterns
    "ctx 63k": "上下文 63k",
    "ctx 128k": "上下文 128k",
    "ctx 200k": "上下文 200k",
    "ctx 1M": "上下文 1M",
  };

  // Check exact match
  if (hintTranslations[hint]) {
    return hintTranslations[hint];
  }

  // Try to translate parts
  let result = hint;
  
  // Translate model info patterns
  result = result.replace(/\breasoning\b/g, "推理");
  result = result.replace(/\bctx\b/g, "上下文");
  result = result.replace(/\balias:\s*/g, "别名: ");
  result = result.replace(/\bcurrent\s*\(not in catalog\)/g, "当前 (不在目录中)");
  result = result.replace(/\(recommended\)/g, "(推荐)");
  
  // Translate "X models" in hints
  result = result.replace(/(\d+)\s+models?/gi, "$1 个模型");
  
  // Translate provider descriptions
  result = result.replace(/DeepSeek, GLM, Qwen, Llama via siliconflow\.cn/g, 
    "通过 siliconflow.cn 使用 DeepSeek、GLM、Qwen、Llama");

  // Translate "SiliconFlow 硅基流动 auth method" pattern
  result = result.replace(/SiliconFlow 硅基流动 auth method/g, "硅基流动 SiliconFlow 认证方式");
  result = result.replace(/auth method/g, "认证方式");
  
  // Translate "(multi-model)" pattern
  result = result.replace(/\(multi-model\)/g, "(多模型)");

  return result;
}
