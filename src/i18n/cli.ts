export type CliLocale = "en" | "zh-CN";

type CliMessageKey =
  | "wizard.setupCancelled"
  | "wizard.onboardingTitle"
  | "wizard.securityTitle"
  | "wizard.securityConfirm"
  | "wizard.modeQuestion"
  | "wizard.modeQuickstart"
  | "wizard.modeQuickstartHint"
  | "wizard.modeManual"
  | "wizard.modeManualHint"
  | "wizard.quickstartTitle"
  | "wizard.quickstartSwitchToManual"
  | "wizard.configInvalidOutro"
  | "wizard.existingConfigDetectedTitle"
  | "wizard.configIssuesTitle"
  | "wizard.configHandlingQuestion"
  | "wizard.configHandlingUseExisting"
  | "wizard.configHandlingUpdate"
  | "wizard.configHandlingReset"
  | "wizard.resetScopeQuestion"
  | "wizard.resetScopeConfigOnly"
  | "wizard.resetScopeConfigCredsSessions"
  | "wizard.resetScopeFull"
  | "wizard.setupTargetQuestion"
  | "wizard.setupTargetLocal"
  | "wizard.setupTargetLocalReachableHint"
  | "wizard.setupTargetLocalUnreachableHint"
  | "wizard.setupTargetRemote"
  | "wizard.setupTargetRemoteNoConfigHint"
  | "wizard.setupTargetRemoteReachableHint"
  | "wizard.setupTargetRemoteUnreachableHint"
  | "wizard.workspaceDirectoryQuestion"
  | "wizard.skipChannelsNote"
  | "wizard.channelsTitle"
  | "wizard.skipSkillsNote"
  | "wizard.skillsTitle"
  | "wizard.remoteConfigured";

type CliMessages = Record<CliMessageKey, string>;

type CliTemplateVars = Record<string, string | number>;

const EN_MESSAGES: CliMessages = {
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
};

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
};

function normalizeLocale(raw: string): CliLocale {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return "en";
  }

  const normalized = value.replace(/_/g, "-").split(".")[0] ?? value;
  if (normalized === "zh-cn" || normalized === "zh-hans") {
    return "zh-CN";
  }

  return "en";
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
