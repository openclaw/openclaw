/** Updates installed plugins across npm, ClawHub, marketplace, Git, and bundled bridge sources. */
export type {
  PluginUpdateChannelFallback,
  PluginUpdateIntegrityDriftParams,
  PluginUpdateLogger,
  PluginUpdateOutcome,
  PluginUpdateSummary,
} from "./update-source.js";
export type { PluginChannelSyncResult, PluginChannelSyncSummary } from "./update-channel.js";

export {
  isPluginInstallRecordUpdateSource,
  pluginInstallRecordMayMigrateConfigId,
} from "./update-source.js";
export { isClawHubTrustSkippedOutcome } from "./update-attempt.js";
export { updateNpmInstalledPlugins } from "./update-installed.js";
export { syncPluginsForUpdateChannel } from "./update-channel.js";
