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
  | "wizard.remoteConfigured";

type CliMessages = Record<CliMessageKey, string>;

const EN_MESSAGES: CliMessages = {
  "wizard.setupCancelled": "Setup cancelled.",
  "wizard.onboardingTitle": "OpenClaw onboarding",
  "wizard.securityTitle": "Security",
  "wizard.securityConfirm":
    "I understand this is personal-by-default and shared/multi-user use requires lock-down. Continue?",
  "wizard.modeQuestion": "Onboarding mode",
  "wizard.modeQuickstart": "QuickStart",
  "wizard.modeQuickstartHint": "Configure details later via openclaw configure.",
  "wizard.modeManual": "Manual",
  "wizard.modeManualHint": "Configure port, network, Tailscale, and auth options.",
  "wizard.quickstartTitle": "QuickStart",
  "wizard.quickstartSwitchToManual":
    "QuickStart only supports local gateways. Switching to Manual mode.",
  "wizard.configInvalidOutro":
    "Config invalid. Run `openclaw doctor` to repair it, then re-run onboarding.",
  "wizard.remoteConfigured": "Remote gateway configured.",
};

const ZH_CN_MESSAGES: CliMessages = {
  "wizard.setupCancelled": "安装向导已取消。",
  "wizard.onboardingTitle": "OpenClaw 初始化向导",
  "wizard.securityTitle": "安全提醒",
  "wizard.securityConfirm": "我理解默认是个人使用场景，多用户/共享场景需要额外加固。是否继续？",
  "wizard.modeQuestion": "初始化模式",
  "wizard.modeQuickstart": "快速开始",
  "wizard.modeQuickstartHint": "稍后可通过 openclaw configure 继续细化配置。",
  "wizard.modeManual": "手动配置",
  "wizard.modeManualHint": "配置端口、网络、Tailscale 与认证选项。",
  "wizard.quickstartTitle": "快速开始",
  "wizard.quickstartSwitchToManual": "快速开始仅支持本地网关，已切换到手动模式。",
  "wizard.configInvalidOutro": "配置文件无效。请先运行 `openclaw doctor` 修复，再重新执行初始化。",
  "wizard.remoteConfigured": "远程网关已配置完成。",
};

function normalizeLocale(raw: string): CliLocale {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return "en";
  }
  if (value === "zh-cn" || value === "zh_cn" || value.startsWith("zh")) {
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

export function cliT(key: CliMessageKey, env: NodeJS.ProcessEnv = process.env): string {
  const locale = resolveCliLocale(env);
  const messages = locale === "zh-CN" ? ZH_CN_MESSAGES : EN_MESSAGES;
  return messages[key] ?? EN_MESSAGES[key];
}
