import type { CliLocale } from "../config/types.cli.js";

type CliTemplateVars = Record<string, string | number>;

const EN_MESSAGES = {
  "wizard.setupCancelled": "Setup cancelled.",
  "wizard.onboardingTitle": "OpenClaw onboarding",
  "wizard.securityTitle": "Security",
  "wizard.securityConfirm":
    "I understand this is personal-by-default and shared/multi-user use requires lock-down. Continue?",
  "wizard.modeQuestion": "Onboarding mode",
  "wizard.modeQuickstart": "QuickStart",
  "wizard.modeQuickstartHint": "Configure details later via {configureCommand}.",
  "wizard.modeManual": "Manual",
  "wizard.modeManualHint": "Configure port, network, Tailscale, and auth options.",
  "wizard.quickstartTitle": "QuickStart",
  "wizard.quickstartSwitchToManual":
    "QuickStart only supports local gateways. Switching to Manual mode.",
  "wizard.invalidConfigTitle": "Invalid config",
  "wizard.configInvalidOutro":
    "Config invalid. Run `{doctorCommand}` to repair it, then re-run onboarding.",
  "wizard.existingConfigDetectedTitle": "Existing config detected",
  "wizard.configIssuesTitle": "Config issues",
  "wizard.configHandlingQuestion": "Config handling",
  "wizard.configHandlingUseExisting": "Use existing values",
  "wizard.configHandlingUpdate": "Update values",
  "wizard.configHandlingReset": "Reset",
  "wizard.resetScopeQuestion": "Reset scope",
  "wizard.resetScopeConfigOnly": "Config only",
  "wizard.resetScopeConfigCredsSessions": "Config + creds + sessions",
  "wizard.resetScopeFull": "Full reset (config + creds + sessions + workspace)",
  "wizard.setupTargetQuestion": "What do you want to set up?",
  "wizard.setupTargetLocal": "Local gateway (this machine)",
  "wizard.setupTargetLocalReachableHint": "Gateway reachable ({url})",
  "wizard.setupTargetLocalUnreachableHint": "No gateway detected ({url})",
  "wizard.setupTargetRemote": "Remote gateway (info-only)",
  "wizard.setupTargetRemoteNoConfigHint": "No remote URL configured yet",
  "wizard.setupTargetRemoteReachableHint": "Gateway reachable ({url})",
  "wizard.setupTargetRemoteUnreachableHint": "Configured but unreachable ({url})",
  "wizard.workspaceDirectoryQuestion": "Workspace directory",
  "wizard.skipChannelsNote": "Skipping channel setup.",
  "wizard.channelsTitle": "Channels",
  "wizard.skipSkillsNote": "Skipping skills setup.",
  "wizard.skillsTitle": "Skills",
  "wizard.remoteConfigured": "Remote gateway configured.",
  "wizard.languageQuestion": "Language / 语言",
  "wizard.languageOptionEnglish": "English",
  "wizard.languageOptionEnglishHint": "Default",
  "wizard.languageOptionZhCn": "简体中文",
  "wizard.languageOptionZhCnHint": "Recommended",
  "wizard.securityWarningBody":
    "Security warning — please read.\n\nOpenClaw is a hobby project and still in beta. Expect sharp edges.\nBy default, OpenClaw is a personal agent: one trusted operator boundary.\nThis bot can read files and run actions if tools are enabled.\nA bad prompt can trick it into doing unsafe things.\n\nOpenClaw is not a hostile multi-tenant boundary by default.\nIf multiple users can message one tool-enabled agent, they share that delegated tool authority.\n\nIf you’re not comfortable with security hardening and access control, don’t run OpenClaw.\nAsk someone experienced to help before enabling tools or exposing it to the internet.\n\nRecommended baseline:\n- Pairing/allowlists + mention gating.\n- Multi-user/shared inbox: split trust boundaries (separate gateway/credentials, ideally separate OS users/hosts).\n- Sandbox + least-privilege tools.\n- Shared inboxes: isolate DM sessions (`session.dmScope: per-channel-peer`) and keep tool access minimal.\n- Keep secrets out of the agent’s reachable filesystem.\n- Use the strongest available model for any bot with tools or untrusted inboxes.\n\nRun regularly:\n{auditDeepCommand}\n{auditFixCommand}\n\nMust read: https://docs.openclaw.ai/gateway/security",
  "wizard.docsConfigLine": "Docs: https://docs.openclaw.ai/gateway/configuration",
  "wizard.errorInvalidFlow": "Invalid --flow (use quickstart, manual, or advanced).",
  "wizard.quickstartSummaryKeepExisting": "Keeping your current gateway settings:",
  "wizard.quickstartGatewayPortLine": "Gateway port: {port}",
  "wizard.quickstartGatewayBindLine": "Gateway bind: {bind}",
  "wizard.quickstartGatewayCustomIpLine": "Gateway custom IP: {host}",
  "wizard.quickstartGatewayAuthLine": "Gateway auth: {auth}",
  "wizard.quickstartTailscaleExposureLine": "Tailscale exposure: {tailscale}",
  "wizard.quickstartDirectChatLine": "Direct to chat channels.",
  "wizard.quickstartDefaultGatewayBindLine": "Gateway bind: Loopback (127.0.0.1)",
  "wizard.quickstartDefaultGatewayAuthLine": "Gateway auth: Token (default)",
  "wizard.quickstartDefaultTailscaleLine": "Tailscale exposure: Off",
  "wizard.quickstartBindLoopback": "Loopback (127.0.0.1)",
  "wizard.quickstartBindLan": "LAN",
  "wizard.quickstartBindCustom": "Custom IP",
  "wizard.quickstartBindTailnet": "Tailnet (Tailscale IP)",
  "wizard.quickstartBindAuto": "Auto",
  "wizard.quickstartAuthTokenDefault": "Token (default)",
  "wizard.quickstartAuthPassword": "Password",
  "wizard.quickstartTailscaleOff": "Off",
  "wizard.quickstartTailscaleServe": "Serve",
  "wizard.quickstartTailscaleFunnel": "Funnel",
  "wizard.gatewayAuthTitle": "Gateway auth",
  "wizard.gatewayAuthResolveProbeError":
    "Could not resolve gateway.auth.password SecretRef for onboarding probe.",
  "wizard.gatewayPortQuestion": "Gateway port",
  "wizard.invalidPortError": "Invalid port",
  "wizard.gatewayBindQuestion": "Gateway bind",
  "wizard.gatewayBindLoopbackLabel": "Loopback (127.0.0.1)",
  "wizard.gatewayBindLanLabel": "LAN (0.0.0.0)",
  "wizard.gatewayBindTailnetLabel": "Tailnet (Tailscale IP)",
  "wizard.gatewayBindAutoLabel": "Auto (Loopback → LAN)",
  "wizard.gatewayBindCustomLabel": "Custom IP",
  "wizard.customIpAddressQuestion": "Custom IP address",
  "wizard.customIpAddressPlaceholder": "192.168.1.100",
  "wizard.gatewayAuthQuestion": "Gateway auth",
  "wizard.gatewayAuthTokenLabel": "Token",
  "wizard.gatewayAuthTokenHint": "Recommended default (local + remote)",
  "wizard.gatewayAuthPasswordLabel": "Password",
  "wizard.tailscaleExposureQuestion": "Tailscale exposure",
  "wizard.tailscaleExposureOffLabel": "Off",
  "wizard.tailscaleExposureOffHint": "No Tailscale exposure",
  "wizard.tailscaleExposureServeLabel": "Serve",
  "wizard.tailscaleExposureServeHint": "Private HTTPS for your tailnet (devices on Tailscale)",
  "wizard.tailscaleExposureFunnelLabel": "Funnel",
  "wizard.tailscaleExposureFunnelHint": "Public HTTPS via Tailscale Funnel (internet)",
  "wizard.tailscaleWarningTitle": "Tailscale Warning",
  "wizard.tailscaleTitle": "Tailscale",
  "wizard.tailscaleMissingBinaryBody":
    "Tailscale binary not found in PATH or /Applications.\nEnsure Tailscale is installed from:\n  https://tailscale.com/download/mac\n\nYou can continue setup, but serve/funnel will fail at runtime.",
  "wizard.tailscaleDocsBody":
    "Docs:\nhttps://docs.openclaw.ai/gateway/tailscale\nhttps://docs.openclaw.ai/web",
  "wizard.tailscaleResetOnExitQuestion": "Reset Tailscale serve/funnel on exit?",
  "wizard.noteTitle": "Note",
  "wizard.tailscaleRequiresLoopbackNote":
    "Tailscale requires bind=loopback. Adjusting bind to loopback.",
  "wizard.tailscaleFunnelRequiresPasswordNote": "Tailscale funnel requires password auth.",
  "wizard.gatewayTokenQuestion": "Gateway token (blank to generate)",
  "wizard.gatewayTokenPlaceholder": "Needed for multi-machine or non-loopback access",
  "wizard.secretInputGatewayPasswordModeQuestion":
    "How do you want to provide the gateway password?",
  "wizard.secretInputEnterPasswordNowLabel": "Enter password now",
  "wizard.secretInputEnterPasswordNowHint": "Stores the password directly in OpenClaw config",
  "wizard.secretInputGatewayPasswordSourceQuestion": "Where is this gateway password stored?",
  "wizard.gatewayPasswordQuestion": "Gateway password",
  "wizard.shellCompletionTitle": "Shell completion",
  "wizard.shellCompletionReloadPowerShell":
    "Restart your shell (or reload your PowerShell profile).",
  "wizard.shellCompletionReloadSource": "Restart your shell or run: source {profileHint}",
  "wizard.shellCompletionEnableQuestion": "Enable {shell} shell completion for {cliName}?",
  "wizard.shellCompletionCacheFailedNote":
    "Failed to generate completion cache. Run `{cliName} completion --install` later.",
  "wizard.shellCompletionInstalledNote": "Shell completion installed. {reloadHint}",
  "wizard.remoteHostUnknown": "host unknown",
  "wizard.remoteWsUrlMustStartError": "URL must start with ws:// or wss://",
  "wizard.remoteWsUrlSecurityError":
    "Use wss:// for remote hosts, or ws://127.0.0.1/localhost via SSH tunnel. Break-glass: OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 for trusted private networks.",
  "wizard.remoteDiscoverLanQuestion": "Discover gateway on LAN (Bonjour)?",
  "wizard.discoveryTitle": "Discovery",
  "wizard.discoveryRequirementBody":
    "Bonjour discovery requires dns-sd (macOS) or avahi-browse (Linux).\nDocs: https://docs.openclaw.ai/gateway/discovery",
  "wizard.discoverySearchingProgress": "Searching for gateways…",
  "wizard.discoveryFoundProgress": "Found {count} gateway(s)",
  "wizard.discoveryNoneProgress": "No gateways found",
  "wizard.remoteSelectGatewayQuestion": "Select gateway",
  "wizard.remoteEnterUrlManuallyLabel": "Enter URL manually",
  "wizard.remoteConnectionMethodQuestion": "Connection method",
  "wizard.remoteConnectionDirectLabel": "Direct gateway WS ({host}:{port})",
  "wizard.remoteConnectionSshLabel": "SSH tunnel (loopback)",
  "wizard.directRemoteTitle": "Direct remote",
  "wizard.remoteDirectDefaultsToTlsLine": "Direct remote access defaults to TLS.",
  "wizard.remoteDirectUsingLine": "Using: {url}",
  "wizard.remoteDirectLoopbackHintLine":
    "If your gateway is loopback-only, choose SSH tunnel and keep ws://127.0.0.1:18789.",
  "wizard.sshTunnelTitle": "SSH tunnel",
  "wizard.remoteSshStartTunnelLine": "Start a tunnel before using the CLI:",
  "wizard.remoteSshDocsLine": "Docs: https://docs.openclaw.ai/gateway/remote",
  "wizard.remoteGatewayWsUrlQuestion": "Gateway WebSocket URL",
  "wizard.remoteGatewayAuthQuestion": "Gateway auth",
  "wizard.remoteGatewayAuthTokenRecommendedLabel": "Token (recommended)",
  "wizard.remoteGatewayAuthPasswordLabel": "Password",
  "wizard.remoteGatewayAuthOffLabel": "No auth",
  "wizard.secretInputGatewayTokenModeQuestion": "How do you want to provide this gateway token?",
  "wizard.secretInputEnterTokenNowLabel": "Enter token now",
  "wizard.secretInputEnterTokenNowHint": "Stores the token directly in OpenClaw config",
  "wizard.secretInputGatewayTokenSourceQuestion": "Where is this gateway token stored?",
  "wizard.remoteGatewayTokenQuestion": "Gateway token",
  "wizard.requiredFieldError": "Required",
  "wizard.secretInputRemoteGatewayPasswordModeQuestion":
    "How do you want to provide this gateway password?",
  "wizard.secretInputRemoteGatewayPasswordSourceQuestion": "Where is this gateway password stored?",
  "wizard.remoteGatewayPasswordQuestion": "Gateway password",
  "wizard.systemdTitle": "Systemd",
  "wizard.systemdUnavailableNote":
    "Systemd user services are unavailable. Skipping lingering checks and service install.",
  "wizard.systemdLingerReason":
    "Linux installs use a systemd user service by default. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
  "wizard.installGatewayServiceQuestion": "Install Gateway service (recommended)",
  "wizard.systemdUnavailableServiceInstallNote":
    "Systemd user services are unavailable; skipping service install. Use your container supervisor or `docker compose up -d`.",
  "wizard.gatewayServiceTitle": "Gateway service",
  "wizard.gatewayServiceRuntimeQuestion": "Gateway service runtime",
  "wizard.quickstartGatewayRuntimeNodeNote":
    "QuickStart uses Node for the Gateway service (stable + supported).",
  "wizard.gatewayServiceAlreadyInstalledQuestion": "Gateway service already installed",
  "wizard.gatewayServiceActionRestart": "Restart",
  "wizard.gatewayServiceActionReinstall": "Reinstall",
  "wizard.gatewayServiceActionSkip": "Skip",
  "wizard.gatewayServiceRestartingProgress": "Restarting Gateway service…",
  "wizard.gatewayServiceRestartedDone": "Gateway service restarted.",
  "wizard.gatewayServiceUninstallingProgress": "Uninstalling Gateway service…",
  "wizard.gatewayServiceUninstalledDone": "Gateway service uninstalled.",
  "wizard.gatewayServicePreparingProgress": "Preparing Gateway service…",
  "wizard.gatewayServiceInstallingProgress": "Installing Gateway service…",
  "wizard.gatewayServiceInstallFailedDone": "Gateway service install failed.",
  "wizard.gatewayServiceInstalledDone": "Gateway service installed.",
  "wizard.gatewayTitle": "Gateway",
  "wizard.gatewayServiceInstallFailedPrefix": "Gateway service install failed: {error}",
  "wizard.healthCheckHelpTitle": "Health check help",
  "wizard.healthCheckDocsLine": "Docs: https://docs.openclaw.ai/gateway/health",
  "wizard.healthCheckTroubleshootingLine": "https://docs.openclaw.ai/gateway/troubleshooting",
  "wizard.optionalAppsTitle": "Optional apps",
  "wizard.optionalAppsBody":
    "Add nodes for extra features:\n- macOS app (system + notifications)\n- iOS app (camera/canvas)\n- Android app (camera/canvas)",
  "wizard.gatewayAuthResolveOnboardingAuthError":
    "Could not resolve gateway.auth.password SecretRef for onboarding auth.",
  "wizard.controlUiTitle": "Control UI",
  "wizard.controlUiWebUiLine": "Web UI: {url}",
  "wizard.controlUiWebUiWithTokenLine": "Web UI (with token): {url}",
  "wizard.controlUiGatewayWsLine": "Gateway WS: {url}",
  "wizard.controlUiGatewayStatusReachable": "Gateway: reachable",
  "wizard.controlUiGatewayStatusNotDetected": "Gateway: not detected",
  "wizard.controlUiGatewayStatusNotDetectedWithDetail": "Gateway: not detected ({detail})",
  "wizard.controlUiDocsLine": "Docs: https://docs.openclaw.ai/web/control-ui",
  "wizard.startTuiBestOptionTitle": "Start TUI (best option!)",
  "wizard.startTuiBestOptionBody":
    'This is the defining action that makes your agent you.\nPlease take your time.\nThe more you tell it, the better the experience will be.\nWe will send: "Wake up, my friend!"',
  "wizard.tokenTitle": "Token",
  "wizard.tokenInfoBody":
    "Gateway token: shared auth for the Gateway + Control UI.\nStored in: ~/.openclaw/openclaw.json (gateway.auth.token) or OPENCLAW_GATEWAY_TOKEN.\nView token: {viewTokenCommand}\nGenerate token: {generateTokenCommand}\nWeb UI stores a copy in this browser's localStorage (openclaw.control.settings.v1).\nOpen the dashboard anytime: {openDashboardCommand}\nIf prompted: paste the token into Control UI settings (or use the tokenized dashboard URL).",
  "wizard.hatchQuestion": "How do you want to hatch your bot?",
  "wizard.hatchOptionTui": "Hatch in TUI (recommended)",
  "wizard.hatchOptionWeb": "Open the Web UI",
  "wizard.hatchOptionLater": "Do this later",
  "wizard.hatchWakeMessage": "Wake up, my friend!",
  "wizard.dashboardReadyTitle": "Dashboard ready",
  "wizard.dashboardLinkWithTokenLine": "Dashboard link (with token): {url}",
  "wizard.dashboardOpenedLine": "Opened in your browser. Keep that tab to control OpenClaw.",
  "wizard.dashboardCopyLine":
    "Copy/paste this URL in a browser on this machine to control OpenClaw.",
  "wizard.laterTitle": "Later",
  "wizard.laterCommandLine": "When you're ready: {command}",
  "wizard.skipControlUiPromptsNote": "Skipping Control UI/TUI prompts.",
  "wizard.workspaceBackupTitle": "Workspace backup",
  "wizard.workspaceBackupBody":
    "Back up your agent workspace.\nDocs: https://docs.openclaw.ai/concepts/agent-workspace",
  "wizard.securityReminderBody":
    "Running agents on your computer is risky — harden your setup: https://docs.openclaw.ai/security",
  "wizard.webSearchOptionalTitle": "Web search (optional)",
  "wizard.webSearchProviderBrave": "Brave Search",
  "wizard.webSearchProviderPerplexity": "Perplexity Search",
  "wizard.webSearchEnabledIntro":
    "Web search is enabled, so your agent can look things up online when needed.",
  "wizard.webSearchProviderLine": "Provider: {provider}",
  "wizard.webSearchApiKeyStoredInConfigLine": "API key: stored in config ({path}).",
  "wizard.webSearchApiKeyProvidedViaEnvLine":
    "API key: provided via {envVar} env var (Gateway environment).",
  "wizard.webSearchDocsLine": "Docs: https://docs.openclaw.ai/tools/web",
  "wizard.webSearchNeedsApiKeyIntro":
    "To enable web search, your agent will need an API key for either Perplexity Search or Brave Search.",
  "wizard.webSearchSetupInteractivelyLine": "Set it up interactively:",
  "wizard.webSearchRunConfigureWebLine": "- Run: {command}",
  "wizard.webSearchChooseProviderPasteKeyLine": "- Choose a provider and paste your API key",
  "wizard.webSearchAlternativeEnvLine":
    "Alternative: set PERPLEXITY_API_KEY or BRAVE_API_KEY in the Gateway environment (no config changes).",
  "wizard.whatNowTitle": "What now",
  "wizard.whatNowBody": 'What now: https://openclaw.ai/showcase ("What People Are Building").',
  "wizard.outroDashboardOpened":
    "Onboarding complete. Dashboard opened; keep that tab to control OpenClaw.",
  "wizard.outroSeededBackground":
    "Onboarding complete. Web UI seeded in the background; open it anytime with the dashboard link above.",
  "wizard.outroComplete": "Onboarding complete. Use the dashboard link above to control OpenClaw.",
} as const;

type CliMessageKey = keyof typeof EN_MESSAGES;
type CliMessages = Record<CliMessageKey, string>;

const ZH_CN_MESSAGES: CliMessages = {
  "wizard.setupCancelled": "安装向导已取消。",
  "wizard.onboardingTitle": "OpenClaw 初始化向导",
  "wizard.securityTitle": "安全提醒",
  "wizard.securityConfirm": "我理解默认是个人使用场景，多用户/共享场景需要额外加固。是否继续？",
  "wizard.modeQuestion": "初始化模式",
  "wizard.modeQuickstart": "快速开始",
  "wizard.modeQuickstartHint": "稍后可通过 {configureCommand} 继续细化配置。",
  "wizard.modeManual": "手动配置",
  "wizard.modeManualHint": "配置端口、网络、Tailscale 与认证选项。",
  "wizard.quickstartTitle": "快速开始",
  "wizard.quickstartSwitchToManual": "快速开始仅支持本地网关，已切换到手动模式。",
  "wizard.invalidConfigTitle": "配置无效",
  "wizard.configInvalidOutro": "配置文件无效。请先运行 `{doctorCommand}` 修复，再重新执行初始化。",
  "wizard.existingConfigDetectedTitle": "检测到已有配置",
  "wizard.configIssuesTitle": "配置问题",
  "wizard.configHandlingQuestion": "如何处理现有配置",
  "wizard.configHandlingUseExisting": "沿用现有配置",
  "wizard.configHandlingUpdate": "更新配置",
  "wizard.configHandlingReset": "重置",
  "wizard.resetScopeQuestion": "重置范围",
  "wizard.resetScopeConfigOnly": "仅重置配置",
  "wizard.resetScopeConfigCredsSessions": "重置配置 + 凭据 + 会话",
  "wizard.resetScopeFull": "完全重置（配置 + 凭据 + 会话 + 工作区）",
  "wizard.setupTargetQuestion": "你想配置哪一种",
  "wizard.setupTargetLocal": "本地网关（当前机器）",
  "wizard.setupTargetLocalReachableHint": "网关可达（{url}）",
  "wizard.setupTargetLocalUnreachableHint": "未检测到网关（{url}）",
  "wizard.setupTargetRemote": "远程网关（仅信息配置）",
  "wizard.setupTargetRemoteNoConfigHint": "尚未配置远程 URL",
  "wizard.setupTargetRemoteReachableHint": "网关可达（{url}）",
  "wizard.setupTargetRemoteUnreachableHint": "已配置但不可达（{url}）",
  "wizard.workspaceDirectoryQuestion": "工作区目录",
  "wizard.skipChannelsNote": "已跳过频道配置。",
  "wizard.channelsTitle": "频道",
  "wizard.skipSkillsNote": "已跳过技能配置。",
  "wizard.skillsTitle": "技能",
  "wizard.remoteConfigured": "远程网关已配置完成。",
  "wizard.languageQuestion": "语言 / Language",
  "wizard.languageOptionEnglish": "English",
  "wizard.languageOptionEnglishHint": "默认",
  "wizard.languageOptionZhCn": "简体中文",
  "wizard.languageOptionZhCnHint": "推荐",
  "wizard.securityWarningBody":
    "安全警告——请先阅读。\n\nOpenClaw 仍是偏实验性的项目，可能有不稳定行为。\n默认前提是：个人使用、单一可信操作者边界。\n开启工具后，Bot 可以读文件并执行动作。\n恶意或误导性提示词可能诱导它执行不安全操作。\n\nOpenClaw 默认不是对抗型多租户安全边界。\n若多人都能给同一个可用工具的代理发消息，本质上是在共享被委托的工具权限。\n\n如果你不熟悉安全加固和访问控制，请先不要直接上线。\n启用工具或暴露公网前，建议请有经验的人协助。\n\n基础建议：\n- 配对/白名单 + mention 门控。\n- 多用户/共享收件箱请拆分信任边界（独立网关/凭据，最好独立系统用户或主机）。\n- 沙箱 + 最小权限工具。\n- 共享收件箱中隔离 DM 会话（`session.dmScope: per-channel-peer`）并收紧工具权限。\n- 机密不要放在代理可读路径。\n- 对外开放或接入不可信输入时，优先使用能力更强的模型。\n\n建议定期执行：\n{auditDeepCommand}\n{auditFixCommand}\n\n必读：https://docs.openclaw.ai/gateway/security",
  "wizard.docsConfigLine": "文档: https://docs.openclaw.ai/gateway/configuration",
  "wizard.errorInvalidFlow": "无效的 --flow（可选 quickstart、manual 或 advanced）。",
  "wizard.quickstartSummaryKeepExisting": "将沿用你现有的网关设置：",
  "wizard.quickstartGatewayPortLine": "网关端口: {port}",
  "wizard.quickstartGatewayBindLine": "网关绑定: {bind}",
  "wizard.quickstartGatewayCustomIpLine": "网关自定义 IP: {host}",
  "wizard.quickstartGatewayAuthLine": "网关认证: {auth}",
  "wizard.quickstartTailscaleExposureLine": "Tailscale 暴露: {tailscale}",
  "wizard.quickstartDirectChatLine": "直接接入聊天渠道。",
  "wizard.quickstartDefaultGatewayBindLine": "网关绑定: Loopback (127.0.0.1)",
  "wizard.quickstartDefaultGatewayAuthLine": "网关认证: Token（默认）",
  "wizard.quickstartDefaultTailscaleLine": "Tailscale 暴露: Off",
  "wizard.quickstartBindLoopback": "Loopback (127.0.0.1)",
  "wizard.quickstartBindLan": "LAN",
  "wizard.quickstartBindCustom": "自定义 IP",
  "wizard.quickstartBindTailnet": "Tailnet（Tailscale IP）",
  "wizard.quickstartBindAuto": "自动",
  "wizard.quickstartAuthTokenDefault": "Token（默认）",
  "wizard.quickstartAuthPassword": "密码",
  "wizard.quickstartTailscaleOff": "关闭",
  "wizard.quickstartTailscaleServe": "Serve",
  "wizard.quickstartTailscaleFunnel": "Funnel",
  "wizard.gatewayAuthTitle": "网关认证",
  "wizard.gatewayAuthResolveProbeError": "无法解析用于探测的 gateway.auth.password SecretRef。",
  "wizard.gatewayPortQuestion": "网关端口",
  "wizard.invalidPortError": "端口无效",
  "wizard.gatewayBindQuestion": "网关绑定",
  "wizard.gatewayBindLoopbackLabel": "Loopback (127.0.0.1)",
  "wizard.gatewayBindLanLabel": "LAN (0.0.0.0)",
  "wizard.gatewayBindTailnetLabel": "Tailnet（Tailscale IP）",
  "wizard.gatewayBindAutoLabel": "自动（Loopback → LAN）",
  "wizard.gatewayBindCustomLabel": "自定义 IP",
  "wizard.customIpAddressQuestion": "自定义 IP 地址",
  "wizard.customIpAddressPlaceholder": "192.168.1.100",
  "wizard.gatewayAuthQuestion": "网关认证",
  "wizard.gatewayAuthTokenLabel": "Token",
  "wizard.gatewayAuthTokenHint": "推荐默认值（本地 + 远程）",
  "wizard.gatewayAuthPasswordLabel": "密码",
  "wizard.tailscaleExposureQuestion": "Tailscale 暴露方式",
  "wizard.tailscaleExposureOffLabel": "关闭",
  "wizard.tailscaleExposureOffHint": "不通过 Tailscale 暴露",
  "wizard.tailscaleExposureServeLabel": "Serve",
  "wizard.tailscaleExposureServeHint": "为 tailnet 设备提供私有 HTTPS",
  "wizard.tailscaleExposureFunnelLabel": "Funnel",
  "wizard.tailscaleExposureFunnelHint": "通过 Tailscale Funnel 提供公网 HTTPS",
  "wizard.tailscaleWarningTitle": "Tailscale 警告",
  "wizard.tailscaleTitle": "Tailscale",
  "wizard.tailscaleMissingBinaryBody":
    "在 PATH 或 /Applications 中未找到 Tailscale 可执行文件。\n请先安装 Tailscale：\n  https://tailscale.com/download/mac\n\n你可以继续配置，但 serve/funnel 在运行时会失败。",
  "wizard.tailscaleDocsBody":
    "文档：\nhttps://docs.openclaw.ai/gateway/tailscale\nhttps://docs.openclaw.ai/web",
  "wizard.tailscaleResetOnExitQuestion": "退出时是否重置 Tailscale serve/funnel？",
  "wizard.noteTitle": "提示",
  "wizard.tailscaleRequiresLoopbackNote": "Tailscale 要求 bind=loopback，已自动调整为 loopback。",
  "wizard.tailscaleFunnelRequiresPasswordNote": "Tailscale funnel 需要使用密码认证。",
  "wizard.gatewayTokenQuestion": "网关 Token（留空自动生成）",
  "wizard.gatewayTokenPlaceholder": "用于多机访问或非 loopback 访问",
  "wizard.secretInputGatewayPasswordModeQuestion": "你想如何提供网关密码？",
  "wizard.secretInputEnterPasswordNowLabel": "现在输入密码",
  "wizard.secretInputEnterPasswordNowHint": "会将密码直接写入 OpenClaw 配置",
  "wizard.secretInputGatewayPasswordSourceQuestion": "这个网关密码存放在哪？",
  "wizard.gatewayPasswordQuestion": "网关密码",
  "wizard.shellCompletionTitle": "Shell 补全",
  "wizard.shellCompletionReloadPowerShell": "重启 shell（或重新加载 PowerShell profile）。",
  "wizard.shellCompletionReloadSource": "重启 shell，或执行：source {profileHint}",
  "wizard.shellCompletionEnableQuestion": "为 {cliName} 启用 {shell} shell 补全吗？",
  "wizard.shellCompletionCacheFailedNote":
    "生成补全缓存失败。你可以稍后运行 `{cliName} completion --install`。",
  "wizard.shellCompletionInstalledNote": "Shell 补全已安装。{reloadHint}",
  "wizard.remoteHostUnknown": "未知主机",
  "wizard.remoteWsUrlMustStartError": "URL 必须以 ws:// 或 wss:// 开头",
  "wizard.remoteWsUrlSecurityError":
    "远程主机请使用 wss://，或通过 SSH 隧道使用 ws://127.0.0.1/localhost。紧急放行：可信私网下可设 OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1。",
  "wizard.remoteDiscoverLanQuestion": "在局域网内发现网关（Bonjour）？",
  "wizard.discoveryTitle": "发现",
  "wizard.discoveryRequirementBody":
    "Bonjour 发现需要 dns-sd（macOS）或 avahi-browse（Linux）。\n文档: https://docs.openclaw.ai/gateway/discovery",
  "wizard.discoverySearchingProgress": "正在搜索网关…",
  "wizard.discoveryFoundProgress": "已找到 {count} 个网关",
  "wizard.discoveryNoneProgress": "未找到网关",
  "wizard.remoteSelectGatewayQuestion": "选择网关",
  "wizard.remoteEnterUrlManuallyLabel": "手动输入 URL",
  "wizard.remoteConnectionMethodQuestion": "连接方式",
  "wizard.remoteConnectionDirectLabel": "直连网关 WS（{host}:{port}）",
  "wizard.remoteConnectionSshLabel": "SSH 隧道（loopback）",
  "wizard.directRemoteTitle": "远程直连",
  "wizard.remoteDirectDefaultsToTlsLine": "远程直连默认使用 TLS。",
  "wizard.remoteDirectUsingLine": "当前使用: {url}",
  "wizard.remoteDirectLoopbackHintLine":
    "如果网关仅监听 loopback，请选择 SSH 隧道并保留 ws://127.0.0.1:18789。",
  "wizard.sshTunnelTitle": "SSH 隧道",
  "wizard.remoteSshStartTunnelLine": "使用 CLI 前请先建立隧道：",
  "wizard.remoteSshDocsLine": "文档: https://docs.openclaw.ai/gateway/remote",
  "wizard.remoteGatewayWsUrlQuestion": "网关 WebSocket URL",
  "wizard.remoteGatewayAuthQuestion": "网关认证",
  "wizard.remoteGatewayAuthTokenRecommendedLabel": "Token（推荐）",
  "wizard.remoteGatewayAuthPasswordLabel": "密码",
  "wizard.remoteGatewayAuthOffLabel": "无认证",
  "wizard.secretInputGatewayTokenModeQuestion": "你想如何提供这个网关 Token？",
  "wizard.secretInputEnterTokenNowLabel": "现在输入 Token",
  "wizard.secretInputEnterTokenNowHint": "会将 Token 直接写入 OpenClaw 配置",
  "wizard.secretInputGatewayTokenSourceQuestion": "这个网关 Token 存放在哪？",
  "wizard.remoteGatewayTokenQuestion": "网关 Token",
  "wizard.requiredFieldError": "必填",
  "wizard.secretInputRemoteGatewayPasswordModeQuestion": "你想如何提供这个网关密码？",
  "wizard.secretInputRemoteGatewayPasswordSourceQuestion": "这个网关密码存放在哪？",
  "wizard.remoteGatewayPasswordQuestion": "网关密码",
  "wizard.systemdTitle": "Systemd",
  "wizard.systemdUnavailableNote": "当前不可用 systemd 用户服务，已跳过 lingering 检查和服务安装。",
  "wizard.systemdLingerReason":
    "Linux 默认使用 systemd 用户服务运行网关；若未启用 lingering，用户会话在登出/空闲时会被 systemd 回收，网关也会被停止。",
  "wizard.installGatewayServiceQuestion": "安装网关服务（推荐）",
  "wizard.systemdUnavailableServiceInstallNote":
    "当前不可用 systemd 用户服务，已跳过服务安装。请使用你的容器监管器或 `docker compose up -d`。",
  "wizard.gatewayServiceTitle": "网关服务",
  "wizard.gatewayServiceRuntimeQuestion": "网关服务运行时",
  "wizard.quickstartGatewayRuntimeNodeNote":
    "QuickStart 默认使用 Node 运行网关服务（稳定且受支持）。",
  "wizard.gatewayServiceAlreadyInstalledQuestion": "检测到已安装网关服务",
  "wizard.gatewayServiceActionRestart": "重启",
  "wizard.gatewayServiceActionReinstall": "重装",
  "wizard.gatewayServiceActionSkip": "跳过",
  "wizard.gatewayServiceRestartingProgress": "正在重启网关服务…",
  "wizard.gatewayServiceRestartedDone": "网关服务已重启。",
  "wizard.gatewayServiceUninstallingProgress": "正在卸载网关服务…",
  "wizard.gatewayServiceUninstalledDone": "网关服务已卸载。",
  "wizard.gatewayServicePreparingProgress": "正在准备网关服务…",
  "wizard.gatewayServiceInstallingProgress": "正在安装网关服务…",
  "wizard.gatewayServiceInstallFailedDone": "网关服务安装失败。",
  "wizard.gatewayServiceInstalledDone": "网关服务已安装。",
  "wizard.gatewayTitle": "网关",
  "wizard.gatewayServiceInstallFailedPrefix": "网关服务安装失败：{error}",
  "wizard.healthCheckHelpTitle": "健康检查帮助",
  "wizard.healthCheckDocsLine": "文档: https://docs.openclaw.ai/gateway/health",
  "wizard.healthCheckTroubleshootingLine": "https://docs.openclaw.ai/gateway/troubleshooting",
  "wizard.optionalAppsTitle": "可选应用",
  "wizard.optionalAppsBody":
    "可添加节点扩展能力：\n- macOS App（系统能力 + 通知）\n- iOS App（相机/canvas）\n- Android App（相机/canvas）",
  "wizard.gatewayAuthResolveOnboardingAuthError":
    "无法解析用于 onboarding 认证的 gateway.auth.password SecretRef。",
  "wizard.controlUiTitle": "控制台 UI",
  "wizard.controlUiWebUiLine": "Web UI: {url}",
  "wizard.controlUiWebUiWithTokenLine": "Web UI（含 token）: {url}",
  "wizard.controlUiGatewayWsLine": "网关 WS: {url}",
  "wizard.controlUiGatewayStatusReachable": "网关：可达",
  "wizard.controlUiGatewayStatusNotDetected": "网关：未检测到",
  "wizard.controlUiGatewayStatusNotDetectedWithDetail": "网关：未检测到（{detail}）",
  "wizard.controlUiDocsLine": "文档: https://docs.openclaw.ai/web/control-ui",
  "wizard.startTuiBestOptionTitle": "启动 TUI（最佳选项）",
  "wizard.startTuiBestOptionBody":
    '这是让你的 agent 形成个性的关键一步。\n请慢慢来。\n你给的信息越充分，后续体验越好。\n我们会发送："Wake up, my friend!"',
  "wizard.tokenTitle": "Token",
  "wizard.tokenInfoBody":
    "Gateway token 是网关与控制台 UI 的共享认证凭据。\n存放位置：~/.openclaw/openclaw.json（gateway.auth.token）或环境变量 OPENCLAW_GATEWAY_TOKEN。\n查看 token：{viewTokenCommand}\n重新生成 token：{generateTokenCommand}\nWeb UI 会在当前浏览器 localStorage（openclaw.control.settings.v1）保存一份。\n随时打开 dashboard：{openDashboardCommand}\n如有提示，请将 token 粘贴到 Control UI 设置中（或直接用带 token 的 dashboard URL）。",
  "wizard.hatchQuestion": "你想如何孵化你的 bot？",
  "wizard.hatchOptionTui": "在 TUI 中孵化（推荐）",
  "wizard.hatchOptionWeb": "打开 Web UI",
  "wizard.hatchOptionLater": "稍后再做",
  "wizard.hatchWakeMessage": "Wake up, my friend!",
  "wizard.dashboardReadyTitle": "Dashboard 已就绪",
  "wizard.dashboardLinkWithTokenLine": "Dashboard 链接（含 token）：{url}",
  "wizard.dashboardOpenedLine": "已在浏览器打开，请保留该标签页来控制 OpenClaw。",
  "wizard.dashboardCopyLine": "请在本机浏览器中复制/粘贴这个 URL 来控制 OpenClaw。",
  "wizard.laterTitle": "稍后",
  "wizard.laterCommandLine": "准备好后执行：{command}",
  "wizard.skipControlUiPromptsNote": "已跳过 Control UI/TUI 提示。",
  "wizard.workspaceBackupTitle": "工作区备份",
  "wizard.workspaceBackupBody":
    "请备份你的 agent 工作区。\n文档: https://docs.openclaw.ai/concepts/agent-workspace",
  "wizard.securityReminderBody":
    "在你的电脑上运行代理有风险——请先完成安全加固：https://docs.openclaw.ai/security",
  "wizard.webSearchOptionalTitle": "Web 搜索（可选）",
  "wizard.webSearchProviderBrave": "Brave Search",
  "wizard.webSearchProviderPerplexity": "Perplexity Search",
  "wizard.webSearchEnabledIntro": "已启用 Web 搜索，代理可在需要时在线检索信息。",
  "wizard.webSearchProviderLine": "提供商: {provider}",
  "wizard.webSearchApiKeyStoredInConfigLine": "API key: 已存入配置（{path}）。",
  "wizard.webSearchApiKeyProvidedViaEnvLine":
    "API key: 通过环境变量 {envVar} 提供（Gateway 运行环境）。",
  "wizard.webSearchDocsLine": "文档: https://docs.openclaw.ai/tools/web",
  "wizard.webSearchNeedsApiKeyIntro":
    "要启用 Web 搜索，需要为 Perplexity Search 或 Brave Search 配置 API key。",
  "wizard.webSearchSetupInteractivelyLine": "可通过交互方式配置：",
  "wizard.webSearchRunConfigureWebLine": "- 运行：{command}",
  "wizard.webSearchChooseProviderPasteKeyLine": "- 选择提供商并粘贴 API key",
  "wizard.webSearchAlternativeEnvLine":
    "也可以在 Gateway 环境中设置 PERPLEXITY_API_KEY 或 BRAVE_API_KEY（无需改配置文件）。",
  "wizard.whatNowTitle": "接下来",
  "wizard.whatNowBody": "接下来：https://openclaw.ai/showcase（What People Are Building）。",
  "wizard.outroDashboardOpened": "初始化完成。Dashboard 已打开，请保留该标签页控制 OpenClaw。",
  "wizard.outroSeededBackground":
    "初始化完成。Web UI 已在后台完成初始化，你可以随时用上面的 dashboard 链接打开。",
  "wizard.outroComplete": "初始化完成。请使用上方 dashboard 链接控制 OpenClaw。",
};

export function parseCliLocale(raw: string | undefined | null): CliLocale | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/_/g, "-").split(".")[0] ?? value;
  if (normalized === "zh-cn" || normalized === "zh-hans") {
    return "zh-CN";
  }
  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en";
  }

  return undefined;
}

function normalizeLocale(raw: string): CliLocale {
  return parseCliLocale(raw) ?? "en";
}

export function resolveCliLocale(env: NodeJS.ProcessEnv = process.env): CliLocale {
  const explicit = env.OPENCLAW_LOCALE;
  if (explicit) {
    return normalizeLocale(explicit);
  }
  const lang = env.LANG;
  if (lang) {
    return normalizeLocale(lang);
  }
  return "en";
}

function formatTemplate(message: string, vars?: CliTemplateVars): string {
  if (!vars) {
    return message;
  }
  return message.replace(/\{([a-zA-Z0-9_]+)\}/g, (full, key) => {
    const value = vars[key];
    return value === undefined ? full : String(value);
  });
}

export function cliT(
  key: CliMessageKey,
  env: NodeJS.ProcessEnv = process.env,
  vars?: CliTemplateVars,
): string {
  const locale = resolveCliLocale(env);
  const messages = locale === "zh-CN" ? ZH_CN_MESSAGES : EN_MESSAGES;
  const message = messages[key] ?? EN_MESSAGES[key];
  return formatTemplate(message, vars);
}
