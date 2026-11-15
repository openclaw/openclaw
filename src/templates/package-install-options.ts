import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import type { TemplateInstallOutcome } from "../shared/template-install-notice.js";
import type { TemplateAddStateOptions } from "./add-state-write.js";
import type { PlannedTemplatePackage } from "./package-plan-action.js";
import type { TemplatePluginRuntimeOptions } from "./plugin-runtime.js";

export type TemplatePluginInstallConsent = {
  onCapabilityConsent: PluginCapabilityConsentHandler;
  confirmInstall?: (pluginId: string, warning?: string) => Promise<boolean>;
};

export type TemplateSkillWarning = (
  | Pick<PlannedTemplatePackage, "ref" | "version" | "integrity">
  | { source: "bundled"; path: string; name: string; digest: string }
) & { riskWarning: string };
export type TemplateSkillInstallConsent = { assertApproved: (pkg: TemplateSkillWarning) => void };

export type InstallTemplatePackagesOptions = TemplatePluginRuntimeOptions &
  TemplateAddStateOptions & {
    config?: OpenClawConfig;
    clawHubBaseUrl?: string;
    pluginConsent?: TemplatePluginInstallConsent;
    skillConsent?: TemplateSkillInstallConsent;
    nowMs?: number;
    onSetupOutcome?: (outcome: TemplateInstallOutcome) => Promise<void>;
  };
