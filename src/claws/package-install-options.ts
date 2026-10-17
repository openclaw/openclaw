import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PackageDirInstallTransaction } from "../infra/install-package-dir.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import type { ClawHubSkillUninstallPlan } from "../skills/lifecycle/workspace-types.js";
import type { ClawAddStateOptions } from "./add-state-write.js";
import type { PlannedClawPackage } from "./package-plan-action.js";
import type { ClawPluginRuntimeOptions } from "./plugin-runtime.js";
import type { ClawPackage } from "./schema.js";

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
    pluginInstallMode?: "install" | "update";
    assertPluginOwnerCurrent?: () => Promise<void>;
    nowMs?: number;
    onExternalMutation?: (pkg: ClawPackage) => void;
    skillUpgrade?: {
      ref: string;
      plan: ClawHubSkillUninstallPlan;
      assertCurrent: () => Promise<void>;
    };
    onSkillTransaction?: (pkg: ClawPackage, transaction: PackageDirInstallTransaction) => void;
    stateless?: boolean;
  };
