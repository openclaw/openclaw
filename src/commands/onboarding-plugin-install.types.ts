import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import type { PluginPackageInstall } from "../plugins/manifest.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/** Catalog entry used by onboarding to offer or require a plugin install. */
export type OnboardingPluginInstallEntry = {
  pluginId: string;
  label: string;
  install: PluginPackageInstall;
  trustedSourceLinkedOfficialInstall?: boolean;
  /** Keep this official runtime package on the same release cohort as OpenClaw. */
  versionBoundToOpenClaw?: boolean;
};

export type OnboardingPluginInstallOptions = {
  cfg: OpenClawConfig;
  entry: OnboardingPluginInstallEntry;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
  promptInstall?: boolean;
  autoConfirmSingleSource?: boolean;
  beforePersistentEffect?: () => void | Promise<void>;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  recordOfficialCapabilities?: boolean;
};

/** Config and status returned after attempting an onboarding plugin install. */
export type OnboardingPluginInstallResult = {
  cfg: OpenClawConfig;
  installed: boolean;
  pluginId: string;
  status: "installed" | "skipped" | "failed" | "timed_out";
  /** Sanitized actionable detail for non-interactive callers. */
  error?: string;
};
