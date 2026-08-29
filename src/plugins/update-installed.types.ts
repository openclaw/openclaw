import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import type { PluginCapabilityConsentHandler } from "./capability-consent.js";
import type { InstallSafetyOverrides } from "./install-security-scan.types.js";
import type { PluginUpdateIntegrityDriftParams, PluginUpdateLogger } from "./update-source.js";

export type UpdateNpmInstalledPluginsParams = {
  config: OpenClawConfig;
  logger?: PluginUpdateLogger;
  pluginIds?: string[];
  skipIds?: Set<string>;
  skipDisabledPlugins?: boolean;
  syncOfficialPluginInstalls?: boolean;
  disableOnFailure?: boolean;
  timeoutMs?: number;
  dryRun?: boolean;
  updateChannel?: UpdateChannel;
  officialPluginUpdateChannel?: UpdateChannel;
  coreVersion?: string;
  dangerouslyForceUnsafeInstall?: boolean;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
  specOverrides?: Record<string, string>;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  packagePluginIds?: Readonly<Record<string, readonly string[]>>;
  signal?: AbortSignal;
};
