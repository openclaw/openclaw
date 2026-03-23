// Shared config/runtime boundary for plugins that need config loading,
// config writes, or session-store helpers without importing src internals.

export {
  getRuntimeConfigSnapshot,
  loadConfig,
  readConfigFileSnapshotForWrite,
  writeConfigFile,
} from "../config/io.js";
export { logConfigUpdated } from "../config/logging.js";
export { updateConfig } from "../commands/models/shared.js";
export { resolveMarkdownTableMode } from "../config/markdown-tables.js";
export {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
  type ChannelGroupPolicy,
} from "../config/group-policy.js";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "../config/commands.js";
export {
  TELEGRAM_COMMAND_NAME_PATTERN,
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
} from "../config/telegram-custom-commands.js";
export {
  mapStreamingModeToSlackLegacyDraftStreamMode,
  resolveDiscordPreviewStreamMode,
  resolveSlackNativeStreaming,
  resolveSlackStreamingMode,
  resolveTelegramPreviewStreamMode,
  type SlackLegacyDraftStreamMode,
  type StreamingMode,
} from "../config/discord-preview-streaming.js";
export { resolveActiveTalkProviderConfig } from "../config/talk.js";
export { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
export { loadCronStore, resolveCronStorePath, saveCronStore } from "../cron/store.js";
export { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
export { coerceSecretRef } from "../config/types.secrets.js";
export type {
  DiscordAccountConfig,
  DiscordActionConfig,
  DiscordAutoPresenceConfig,
  DiscordExecApprovalConfig,
  DiscordGuildChannelConfig,
  DiscordGuildEntry,
  DiscordIntentsConfig,
  DiscordSlashCommandConfig,
  DmPolicy,
  GroupPolicy,
  MarkdownTableMode,
  OpenClawConfig,
  ReplyToMode,
  SignalReactionNotificationMode,
  SlackAccountConfig,
  SlackChannelConfig,
  SlackReactionNotificationMode,
  SlackSlashCommandConfig,
  TelegramAccountConfig,
  TelegramActionConfig,
  TelegramDirectConfig,
  TelegramExecApprovalConfig,
  TelegramGroupConfig,
  TelegramInlineButtonsScope,
  TelegramNetworkConfig,
  TelegramTopicConfig,
  TtsConfig,
} from "../config/types.js";
export {
  loadSessionStore,
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  resolveSessionKey,
  resolveStorePath,
  updateLastRoute,
  updateSessionStore,
  type SessionResetMode,
  type SessionScope,
} from "../config/sessions.js";
export { resolveGroupSessionKey } from "../config/sessions/group.js";
export {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../config/sessions/reset.js";
export { resolveSessionStoreEntry } from "../config/sessions/store.js";
export {
  isDangerousNameMatchingEnabled,
  resolveDangerousNameMatchingEnabled,
} from "../config/dangerous-name-matching.js";
