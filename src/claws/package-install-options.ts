import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PackageDirInstallTransaction } from "../infra/install-package-dir.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import type { installPluginFromClawHub } from "../plugins/clawhub.js";
import type { installManagedPlugin } from "../plugins/management-mutations.js";
import type { uninstallPluginWithPolicy } from "../plugins/management-uninstall.js";
import type {
  preflightPluginInstall,
  resolveInstalledClawHubPlugin,
} from "../plugins/plugin-install-preflight.js";
import type {
  installSkillFromClawHub,
  preflightSkillFromClawHub,
} from "../skills/lifecycle/clawhub.js";
import type { ClawHubSkillUninstallPlan } from "../skills/lifecycle/workspace-types.js";
import type { acquireClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";
import type { ClawAddStateOptions } from "./add-state-write.js";
import type { PlannedClawPackage } from "./package-plan-action.js";
import type { inspectClawPluginCapabilities } from "./plugin-capability-probe.js";
import type { ClawPluginRuntimeOptions } from "./plugin-runtime.js";
import type {
  persistClawPackageRef,
  readClawPackageRefs,
  updateClawPackageRefStatus,
} from "./provenance.js";
import type { ClawPackage } from "./types.js";

type PackageInstallerDeps = {
  installPlugin?: (params: Parameters<typeof installManagedPlugin>[0]) => Promise<void>;
  uninstallPlugin?: (params: Parameters<typeof uninstallPluginWithPolicy>[0]) => Promise<void>;
  probePlugin?: typeof installPluginFromClawHub;
  installSkill?: typeof installSkillFromClawHub;
  preflightPlugin?: typeof preflightPluginInstall;
  preflightSkill?: typeof preflightSkillFromClawHub;
  persistPackageRef?: (
    plan: Parameters<typeof persistClawPackageRef>[0],
    pkg: Parameters<typeof persistClawPackageRef>[1],
    options?: Parameters<typeof persistClawPackageRef>[2],
  ) => ReturnType<typeof persistClawPackageRef> | Promise<ReturnType<typeof persistClawPackageRef>>;
  completePackageRef?: (
    ref: Parameters<typeof updateClawPackageRefStatus>[0],
    status: Parameters<typeof updateClawPackageRefStatus>[1],
    options?: Parameters<typeof updateClawPackageRefStatus>[2],
  ) =>
    | ReturnType<typeof updateClawPackageRefStatus>
    | Promise<ReturnType<typeof updateClawPackageRefStatus>>;
  readPackageRefs?: (
    options?: Parameters<typeof readClawPackageRefs>[0],
  ) => ReturnType<typeof readClawPackageRefs> | Promise<ReturnType<typeof readClawPackageRefs>>;
  acquirePackageLease?: typeof acquireClawPackageLifecycleLease;
  resolvePlugin?: typeof resolveInstalledClawHubPlugin;
  inspectPluginCapabilities?: typeof inspectClawPluginCapabilities;
};

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
    deps?: PackageInstallerDeps;
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
