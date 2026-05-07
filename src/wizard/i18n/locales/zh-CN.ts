import type { LocaleMap } from "../types.js";

export const zhCN: LocaleMap = {
  // ===== setup.ts =====
  "OpenClaw setup": "OpenClaw 设置",
  "Setup mode": "设置模式",
  "QuickStart": "快速开始",
  "Manual": "手动配置",
  "Configure details later via openclaw configure.": "后续可通过 openclaw configure 命令配置详情。",
  "Configure port, network, Tailscale, and auth options.": "配置端口、网络、Tailscale 和认证选项。",
  "Config handling": "配置文件处理",
  "Use existing values": "使用现有配置",
  "Update values": "更新配置",
  "Reset": "重置",
  "Config only": "仅重置配置",
  "Config + creds + sessions": "重置配置 + 凭据 + 会话",
  "Full reset (config + creds + sessions + workspace)": "完全重置（配置 + 凭据 + 会话 + 工作区）",
  "Reset scope": "重置范围",
  "Workspace directory": "工作区目录",
  "What do you want to set up?": "您想设置什么？",
  "Local gateway (this machine)": "本地网关（本机）",
  "Remote gateway (info-only)": "远程网关（仅查看）",

  // ===== setup.finalize.ts =====
  "Install Gateway service (recommended)": "安装网关服务（推荐）",
  "Gateway service runtime": "网关服务运行时",
  "Gateway service already installed": "网关服务已安装",
  "Restart": "重启",
  "Reinstall": "重新安装",
  "Skip": "跳过",
  "Gateway service uninstalled.": "网关服务已卸载。",
  "How do you want to hatch your bot?": "您想如何启动您的机器人？",
  "Open the Web UI": "打开 Web 控制面板",
  "Hatch in Terminal (recommended)": "在终端中启动（推荐）",
  "Do this later": "稍后再做",

  // ===== setup.gateway-config.ts =====
  "Gateway auth": "网关认证",
  "Gateway bind": "网关绑定地址",
  "Gateway port": "网关端口",
  "Gateway password": "网关密码",
  "Gateway token (blank to generate)": "网关令牌（留空自动生成）",
  "Loopback (127.0.0.1)": "回环地址（127.0.0.1）",
  "LAN (0.0.0.0)": "局域网（0.0.0.0）",
  "Tailnet (Tailscale IP)": "Tailnet（Tailscale IP）",
  "Custom IP": "自定义 IP",
  "Custom IP address": "自定义 IP 地址",
  "Auto (Loopback → LAN)": "自动（回环 → 局域网）",
  "Tailscale exposure": "Tailscale 对外暴露",
  "Reset Tailscale serve/funnel on exit?": "退出时重置 Tailscale 服务/隧道？",
  "How do you want to provide the gateway token?": "您要如何提供网关令牌？",
  "How do you want to provide the gateway password?": "您要如何提供网关密码？",
  "Where is this gateway token stored?": "此网关令牌存储在哪里？",
  "Where is this gateway password stored?": "此网关密码存储在哪里？",
  "Generate/store plaintext token": "生成/存储明文令牌",
  "Use SecretRef": "使用 SecretRef",
  "Enter password now": "立即输入密码",
  "Token": "令牌",
  "Password": "密码",
  "Use existing gateway token": "使用现有网关令牌",

  // ===== setup.official-plugins.ts =====
  "Install optional plugins": "安装可选插件",
  "Skip for now": "暂时跳过",

  // ===== setup.plugin-config.ts =====
  "Configure plugins (select to set up now, or skip)": "配置插件（选择立即设置，或跳过）",
  "Select plugin to configure": "选择要配置的插件",
  "Back": "返回",
  "Return to section menu": "返回分区菜单",

  // ===== setup.migration-import.ts =====
  "Migration source": "迁移来源",
  "Source agent home": "来源 Agent 目录",
  "Target workspace directory": "目标工作区目录",
  "Apply this migration now?": "立即执行此迁移？",

  // ===== onboard-remote.ts =====
  "Connection method": "连接方式",
  "Discover gateway on LAN (Bonjour)?": "在局域网中发现网关（Bonjour）？",
  "Select gateway": "选择网关",
  "Enter URL manually": "手动输入 URL",
  "Gateway WebSocket URL": "网关 WebSocket 地址",
  "SSH tunnel (loopback)": "SSH 隧道（回环）",
  "No auth": "无需认证",
  "Token (recommended)": "令牌（推荐）",

  // ===== onboard-custom.ts =====
  "OpenAI-compatible": "兼容 OpenAI",
  "Anthropic-compatible": "兼容 Anthropic",
  "Unknown (detect automatically)": "未知（自动检测）",
  "Endpoint compatibility": "接口兼容性",
  "API Base URL": "API 基础地址",
  "Change base URL": "修改基础地址",
  "Change model": "修改模型",
  "Change base URL and model": "修改基础地址和模型",
  "What would you like to change?": "您想修改什么？",
  "Model ID": "模型 ID",
  "Model alias (optional)": "模型别名（可选）",
  "Endpoint ID": "接口 ID",
  "Does this model support image input?": "此模型支持图片输入吗？",

  // ===== onboard-channels.ts =====
  "Select a channel": "选择渠道",
  "Select channel (QuickStart)": "选择渠道（快速开始）",

  // ===== onboard-search.ts =====
  "Keep default": "保留默认值",

  // ===== onboard-hooks.ts =====
  "Enable hooks?": "启用钩子？",

  // ===== onboard-skills.ts =====
  "Configure skills now? (recommended)": "立即配置技能？（推荐）",
  "Install missing skill dependencies": "安装缺失的技能依赖",
  "Show Homebrew install command?": "显示 Homebrew 安装命令？",
  "Preferred node manager for skill installs": "技能安装的首选包管理器",

  // ===== setup.gateway-config.ts (secret mode options) =====
  "Default": "默认",
  "Store a reference instead of plaintext": "存储引用而非明文",

  // ===== ClawSweeper P2 fixes =====
  "Configure details later via": "后续可通过",
  "Enter the gateway password now": "立即输入网关密码",

};
