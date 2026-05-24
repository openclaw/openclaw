import { isClaworksCliProduct } from "../cli/cli-name.js";
import { applyProductSurfaceCopy } from "../cli/product-surface.js";

const CLAWORKS_WIZARD_OVERRIDES: Record<string, string> = {
  "wizard.setup.intro": "ClaWorks setup",
  "wizard.security.beta":
    "ClaWorks is an enterprise robot runtime built on OpenClaw. Expect sharp edges during beta.",
  "wizard.security.personalAgent":
    "By default, ClaWorks is an enterprise robot: one gateway, playbook-driven automation, and IM channels for operators.",
  "wizard.security.notMultitenant": "ClaWorks is not a hostile multi-tenant boundary by default.",
  "wizard.security.hardeningRequired":
    "If you're not comfortable with security hardening and access control, don't run ClaWorks in production.",
  "wizard.security.confirm":
    "I understand shared/multi-user IM access requires lock-down (pairing, RBAC, API keys). Continue?",
  "wizard.finalize.securityReminder":
    "Running an autonomous robot on your network is risky — harden your setup: https://docs.claworks.ai/gateway/security",
  "wizard.finalize.outroDashboardLink":
    "Onboarding complete. Use the dashboard link above to control ClaWorks.",
  "wizard.finalize.outroDashboardOpened":
    "Onboarding complete. Dashboard opened; keep that tab to control ClaWorks.",
  "wizard.finalize.whatNow":
    "What now: https://docs.claworks.ai/showcase (ClaWorks deployment examples).",
};

const CLAWORKS_WIZARD_OVERRIDES_ZH_CN: Record<string, string> = {
  "wizard.setup.intro": "ClaWorks 设置",
  "wizard.security.beta":
    "ClaWorks 是基于 OpenClaw 的企业机器人运行时，Beta 阶段仍可能有粗糙之处。",
  "wizard.security.personalAgent":
    "默认情况下，ClaWorks 是企业自治机器人：一个 Gateway、Playbook 驱动自动化，IM 渠道供运维人员使用。",
  "wizard.security.notMultitenant": "ClaWorks 默认不是面向多租户的 hostile 边界。",
  "wizard.security.hardeningRequired":
    "若尚未做好安全加固与访问控制，请勿在生产环境运行 ClaWorks。",
  "wizard.security.confirm": "我理解多人/共享 IM 访问需要加固（配对、RBAC、API Key）。继续？",
  "wizard.finalize.securityReminder":
    "在网络上运行自治机器人存在风险，请加固配置：https://docs.claworks.ai/gateway/security",
  "wizard.finalize.outroDashboardLink": "Onboarding 完成。使用上面的 dashboard 链接控制 ClaWorks。",
  "wizard.finalize.outroDashboardOpened":
    "Onboarding 完成。Dashboard 已打开；保留该标签页以控制 ClaWorks。",
  "wizard.finalize.whatNow": "下一步：https://docs.claworks.ai/showcase（ClaWorks 部署示例）。",
};

const CLAWORKS_WIZARD_OVERRIDES_ZH_TW: Record<string, string> = {
  "wizard.setup.intro": "ClaWorks 設定",
  "wizard.security.beta":
    "ClaWorks 是基於 OpenClaw 的企業機器人執行環境，Beta 階段仍可能有粗糙之處。",
  "wizard.security.personalAgent":
    "預設情況下，ClaWorks 是企業自治機器人：一個 Gateway、Playbook 驅動自動化，IM 渠道供維運人員使用。",
  "wizard.security.notMultitenant": "ClaWorks 預設不是面向多租户的 hostile 邊界。",
  "wizard.security.hardeningRequired":
    "若尚未做好安全加固與存取控制，請勿在生產環境執行 ClaWorks。",
  "wizard.security.confirm": "我理解多人/共享 IM 存取需要加固（配對、RBAC、API Key）。繼續？",
  "wizard.finalize.securityReminder":
    "在網路上執行自治機器人存在風險，請加固設定：https://docs.claworks.ai/gateway/security",
  "wizard.finalize.outroDashboardLink": "Onboarding 完成。使用上面的 dashboard 連結控制 ClaWorks。",
  "wizard.finalize.outroDashboardOpened":
    "Onboarding 完成。Dashboard 已開啟；保留該分頁以控制 ClaWorks。",
  "wizard.finalize.whatNow": "下一步：https://docs.claworks.ai/showcase（ClaWorks 部署示例）。",
};

function overrideMapForLocale(locale: string): Record<string, string> {
  if (locale === "zh-CN") {
    return CLAWORKS_WIZARD_OVERRIDES_ZH_CN;
  }
  if (locale === "zh-TW") {
    return CLAWORKS_WIZARD_OVERRIDES_ZH_TW;
  }
  return CLAWORKS_WIZARD_OVERRIDES;
}

export function applyClaworksWizardCopy(
  key: string,
  value: string,
  options?: { locale?: string; env?: NodeJS.ProcessEnv },
): string {
  const env = options?.env ?? process.env;
  if (!isClaworksCliProduct(env)) {
    return value;
  }
  const locale = options?.locale ?? "en";
  const overridden = overrideMapForLocale(locale)[key] ?? value;
  return applyProductSurfaceCopy(overridden, env);
}
