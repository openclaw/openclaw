export type { ChannelMessageActionAdapter } from "../channels/plugins/types.js";
export type { OpenClawConfig } from "../config/config.js";
export type { DiscordAccountConfig, DiscordActionConfig } from "../config/types.js";
export type { DiscordPluralKitConfig } from "../../extensions/discord/src/pluralkit.js";
export type { InspectedDiscordAccount } from "../../extensions/discord/src/account-inspect.js";
export type { ResolvedDiscordAccount } from "../../extensions/discord/src/accounts.js";
export type {
  DiscordSendComponents,
  DiscordSendEmbeds,
} from "../../extensions/discord/src/send.shared.js";
export type {
  ThreadBindingManager,
  ThreadBindingRecord,
  ThreadBindingTargetKind,
} from "../../extensions/discord/src/monitor/thread-bindings.js";
export type {
  ChannelMessageActionContext,
  ChannelPlugin,
  OpenClawPluginApi,
  PluginRuntime,
} from "./channel-plugin-common.js";
export {
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  deleteAccountFromConfigSection,
  emptyPluginConfigSchema,
  formatPairingApproveHint,
  getChatChannelMeta,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
} from "./channel-plugin-common.js";
export { formatDocsLink } from "../terminal/links.js";

export {
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
} from "../channels/account-snapshot-fields.js";
export {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
} from "../channels/plugins/directory-config.js";

export {
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
} from "../config/runtime-group-policy.js";
export {
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
} from "../channels/plugins/group-mentions.js";
export { DiscordConfigSchema } from "../config/zod-schema.providers-core.js";

export {
  buildComputedAccountStatusSnapshot,
  buildTokenChannelStatusSummary,
} from "./status-helpers.js";

export {
  createDiscordActionGate,
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
} from "../../extensions/discord/src/accounts.js";
export { inspectDiscordAccount } from "../../extensions/discord/src/account-inspect.js";
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
export {
  autoBindSpawnedDiscordSubagent,
  listThreadBindingsBySessionKey,
  unbindThreadBindingsBySessionKey,
} from "../../extensions/discord/src/monitor/thread-bindings.js";
export { getGateway } from "../../extensions/discord/src/monitor/gateway-registry.js";
export { getPresence } from "../../extensions/discord/src/monitor/presence-cache.js";
export { readDiscordComponentSpec } from "../../extensions/discord/src/components.js";
export { resolveDiscordChannelId } from "../../extensions/discord/src/targets.js";
export {
  addRoleDiscord,
  banMemberDiscord,
  createChannelDiscord,
  createScheduledEventDiscord,
  createThreadDiscord,
  deleteChannelDiscord,
  deleteMessageDiscord,
  editChannelDiscord,
  editMessageDiscord,
  fetchChannelInfoDiscord,
  fetchChannelPermissionsDiscord,
  fetchMemberInfoDiscord,
  fetchMessageDiscord,
  fetchReactionsDiscord,
  fetchRoleInfoDiscord,
  fetchVoiceStatusDiscord,
  hasAnyGuildPermissionDiscord,
  kickMemberDiscord,
  listGuildChannelsDiscord,
  listGuildEmojisDiscord,
  listPinsDiscord,
  listScheduledEventsDiscord,
  listThreadsDiscord,
  moveChannelDiscord,
  pinMessageDiscord,
  reactMessageDiscord,
  readMessagesDiscord,
  removeChannelPermissionDiscord,
  removeOwnReactionsDiscord,
  removeReactionDiscord,
  removeRoleDiscord,
  searchMessagesDiscord,
  sendDiscordComponentMessage,
  sendMessageDiscord,
  sendPollDiscord,
  sendStickerDiscord,
  sendVoiceMessageDiscord,
  setChannelPermissionDiscord,
  timeoutMemberDiscord,
  unpinMessageDiscord,
  uploadEmojiDiscord,
  uploadStickerDiscord,
} from "../../extensions/discord/src/send.js";
export { discordMessageActions } from "../../extensions/discord/src/channel-actions.js";
