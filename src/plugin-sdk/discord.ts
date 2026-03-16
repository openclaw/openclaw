export type { ChannelMessageActionAdapter } from "../channels/plugins/types.js";
export type { OpenClawConfig } from "../config/config.js";
export type { DiscordAccountConfig, DiscordActionConfig } from "../config/types.js";
export type { InspectedDiscordAccount } from "../../extensions/discord/src/account-inspect.js";
export type { ResolvedDiscordAccount } from "../../extensions/discord/src/accounts.js";
export * from "./channel-plugin-common.js";

export {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
} from "../../extensions/discord/src/accounts.js";
export { inspectDiscordAccount } from "../../extensions/discord/src/account-inspect.js";
export {
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
} from "../channels/account-snapshot-fields.js";
export {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
} from "../channels/plugins/directory-config.js";
export {
  looksLikeDiscordTargetId,
  normalizeDiscordMessagingTarget,
  normalizeDiscordOutboundTarget,
} from "../../extensions/discord/src/normalize.js";
export { collectDiscordAuditChannelIds } from "../../extensions/discord/src/audit.js";
export { collectDiscordStatusIssues } from "../../extensions/discord/src/status-issues.js";
export {
  DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS,
  DISCORD_DEFAULT_LISTENER_TIMEOUT_MS,
} from "../../extensions/discord/src/monitor/timeouts.js";
export { normalizeExplicitDiscordSessionKey } from "../../extensions/discord/src/session-key-normalization.js";
export type { DiscordPluralKitConfig } from "../../extensions/discord/src/pluralkit.js";

export {
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
} from "../config/runtime-group-policy.js";
export {
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
} from "../channels/plugins/group-mentions.js";
export { discordSetupWizard } from "../../extensions/discord/src/setup-surface.js";
export { discordSetupAdapter } from "../../extensions/discord/src/setup-core.js";
export { DiscordConfigSchema } from "../config/zod-schema.providers-core.js";

export {
  autoBindSpawnedDiscordSubagent,
  listThreadBindingsBySessionKey,
  unbindThreadBindingsBySessionKey,
} from "../../extensions/discord/src/monitor/thread-bindings.js";
export type {
  ThreadBindingManager,
  ThreadBindingRecord,
  ThreadBindingTargetKind,
} from "../../extensions/discord/src/monitor/thread-bindings.js";

export {
  buildComputedAccountStatusSnapshot,
  buildTokenChannelStatusSummary,
} from "./status-helpers.js";
