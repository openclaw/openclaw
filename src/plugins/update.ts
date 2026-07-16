/** Updates installed plugins across npm, ClawHub, marketplace, Git, and bundled bridge sources. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ClawHubTrustErrorCode } from "../infra/clawhub-install-trust.js";

/** Logger surface used by plugin update flows. */
export type PluginUpdateLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  terminalLinks?: boolean;
};

/** Outcome status for one plugin update attempt. */
type PluginUpdateStatus = "updated" | "unchanged" | "skipped" | "error";

export type PluginUpdateChannelFallback = {
  requestedSpec: string;
  usedSpec: string;
  requestedLabel: string;
  usedLabel: string;
  reason: "unavailable" | "failed";
  message: string;
};

type BasePluginUpdateOutcome = {
  pluginId: string;
  message: string;
  currentVersion?: string;
  nextVersion?: string;
  channelFallback?: PluginUpdateChannelFallback;
  warning?: string;
};

export type PluginUpdateOutcome =
  | (BasePluginUpdateOutcome & {
      status: "skipped";
      code?: ClawHubTrustErrorCode;
    })
  | (BasePluginUpdateOutcome & {
      status: Exclude<PluginUpdateStatus, "skipped">;
      code?: string;
    });

export type PluginUpdateSummary = {
  config: OpenClawConfig;
  changed: boolean;
  outcomes: PluginUpdateOutcome[];
};

export type PluginUpdateIntegrityDriftParams = {
  pluginId: string;
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolvedSpec?: string;
  resolvedVersion?: string;
  dryRun: boolean;
};

export type PluginChannelSyncSummary = {
  switchedToBundled: string[];
  switchedToClawHub: string[];
  switchedToNpm: string[];
  warnings: string[];
  errors: string[];
};

export type PluginChannelSyncResult = {
  config: OpenClawConfig;
  changed: boolean;
  summary: PluginChannelSyncSummary;
};

export {
  isPluginInstallRecordUpdateSource,
  pluginInstallRecordMayMigrateConfigId,
} from "./update-source.js";
export { isClawHubTrustSkippedOutcome } from "./update-attempt.js";
export { updateNpmInstalledPlugins } from "./update-installed.js";
export { syncPluginsForUpdateChannel } from "./update-channel.js";
