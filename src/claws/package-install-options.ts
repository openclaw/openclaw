import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import type { ClawAddStateOptions } from "./add-state-write.js";
import type { PlannedClawPackage } from "./package-plan-action.js";
import type { ClawPluginRuntimeOptions } from "./plugin-runtime.js";

export type ClawPluginInstallConsent = {
  onCapabilityConsent: PluginCapabilityConsentHandler;
  confirmInstall?: (pluginId: string, warning?: string) => Promise<boolean>;
};

export type ClawSkillInstallConsent = {
  assertApproved: (
    pkg: Pick<PlannedClawPackage, "ref" | "version" | "integrity"> & { riskWarning: string },
  ) => void;
};

export type InstallClawPackagesOptions = ClawPluginRuntimeOptions &
  ClawAddStateOptions & {
    config?: OpenClawConfig;
    clawHubBaseUrl?: string;
    pluginConsent?: ClawPluginInstallConsent;
    skillConsent?: ClawSkillInstallConsent;
    nowMs?: number;
  };
