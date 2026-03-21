// Shared config/runtime boundary for plugins that need config loading,
// config writes, or session-store helpers without importing src internals.

import * as sessionConfig from "../config/sessions.js";

export {
  getRuntimeConfigSnapshot,
  loadConfig,
  readConfigFileSnapshotForWrite,
  writeConfigFile,
} from "../config/io.js";
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
export function loadSessionStore(...args: Parameters<typeof sessionConfig.loadSessionStore>) {
  return sessionConfig.loadSessionStore(...args);
}

export function readSessionUpdatedAt(
  ...args: Parameters<typeof sessionConfig.readSessionUpdatedAt>
) {
  return sessionConfig.readSessionUpdatedAt(...args);
}

export function recordSessionMetaFromInbound(
  ...args: Parameters<typeof sessionConfig.recordSessionMetaFromInbound>
) {
  return sessionConfig.recordSessionMetaFromInbound(...args);
}

export function resolveSessionKey(...args: Parameters<typeof sessionConfig.resolveSessionKey>) {
  return sessionConfig.resolveSessionKey(...args);
}

export function resolveStorePath(...args: Parameters<typeof sessionConfig.resolveStorePath>) {
  return sessionConfig.resolveStorePath(...args);
}

export function updateLastRoute(...args: Parameters<typeof sessionConfig.updateLastRoute>) {
  return sessionConfig.updateLastRoute(...args);
}

export function updateSessionStore(...args: Parameters<typeof sessionConfig.updateSessionStore>) {
  return sessionConfig.updateSessionStore(...args);
}

export function resolveSessionStoreEntry(
  ...args: Parameters<typeof sessionConfig.resolveSessionStoreEntry>
) {
  return sessionConfig.resolveSessionStoreEntry(...args);
}

export { resolveGroupSessionKey } from "../config/sessions/group.js";
export {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
  type SessionResetMode,
} from "../config/sessions/reset.js";
export type { SessionScope } from "../config/sessions/types.js";
export { isDangerousNameMatchingEnabled } from "../config/dangerous-name-matching.js";
