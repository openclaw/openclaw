export { CHANNEL_MESSAGE_ACTION_NAMES } from "../channels/plugins/message-action-names.js";
export type {
  ChannelAccountSnapshot,
  ChannelAccountState,
  ChannelAgentTool,
  ChannelAgentToolFactory,
  ChannelAuthAdapter,
  ChannelCapabilities,
  ChannelCommandAdapter,
  ChannelConfigAdapter,
  ChannelDirectoryAdapter,
  ChannelDirectoryEntry,
  ChannelDirectoryEntryKind,
  ChannelElevatedAdapter,
  ChannelGatewayAdapter,
  ChannelGatewayContext,
  ChannelGroupAdapter,
  ChannelGroupContext,
  ChannelHeartbeatAdapter,
  ChannelHeartbeatDeps,
  ChannelId,
  ChannelLogSink,
  ChannelLoginWithQrStartResult,
  ChannelLoginWithQrWaitResult,
  ChannelLogoutContext,
  ChannelLogoutResult,
  ChannelMentionAdapter,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelMessagingAdapter,
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelOutboundTargetMode,
  ChannelPairingAdapter,
  ChannelPollContext,
  ChannelPollResult,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelResolverAdapter,
  ChannelSecurityAdapter,
  ChannelSecurityContext,
  ChannelSecurityDmPolicy,
  ChannelSetupAdapter,
  ChannelSetupInput,
  ChannelStatusAdapter,
  ChannelStatusIssue,
  ChannelStreamingAdapter,
  ChannelThreadingAdapter,
  ChannelThreadingContext,
  ChannelThreadingToolContext,
  ChannelToolSend,
} from "../channels/plugins/types.js";
export type { ChannelConfigSchema, ChannelPlugin } from "../channels/plugins/types.plugin.js";
export type { ClawdbotPluginApi } from "../plugins/types.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { ClawdbotConfig } from "../config/config.js";
export type { ChannelDock } from "../channels/dock.js";
export { getChatChannelMeta } from "../channels/registry.js";
export type {
  DmPolicy,
  GroupPolicy,
  MSTeamsChannelConfig,
  MSTeamsConfig,
  MSTeamsReplyStyle,
  MSTeamsTeamConfig,
} from "../config/types.js";
export {
  DiscordConfigSchema,
  IMessageConfigSchema,
  MSTeamsConfigSchema,
  SignalConfigSchema,
  SlackConfigSchema,
  TelegramConfigSchema,
} from "../config/zod-schema.providers-core.js";
export { WhatsAppConfigSchema } from "../config/zod-schema.providers-whatsapp.js";
export type { RuntimeEnv } from "../runtime.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export type { ReplyPayload } from "../auto-reply/types.js";
export { SILENT_REPLY_TOKEN, isSilentReplyText } from "../auto-reply/tokens.js";
export { chunkMarkdownText, chunkText, resolveTextChunkLimit } from "../auto-reply/chunk.js";
export {
  hasControlCommand,
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
} from "../auto-reply/command-detection.js";
export { shouldHandleTextCommands } from "../auto-reply/commands-registry.js";
export { formatAgentEnvelope } from "../auto-reply/envelope.js";
export {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";
export { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
export { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
export {
  buildPendingHistoryContextFromMap,
  clearHistoryEntries,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntry,
} from "../auto-reply/reply/history.js";
export type { HistoryEntry } from "../auto-reply/reply/history.js";
export { buildMentionRegexes, matchesMentionPatterns } from "../auto-reply/reply/mentions.js";
export { createReplyDispatcherWithTyping } from "../auto-reply/reply/reply-dispatcher.js";
export { resolveEffectiveMessagesConfig, resolveHumanDelayConfig } from "../agents/identity.js";
export { mergeAllowlist, summarizeMapping } from "../channels/allowlists/resolve-utils.js";
export { resolveCommandAuthorizedFromAuthorizers } from "../channels/command-gating.js";
export { resolveMentionGating } from "../channels/mention-gating.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export {
  resolveDiscordGroupRequireMention,
  resolveIMessageGroupRequireMention,
  resolveSlackGroupRequireMention,
  resolveTelegramGroupRequireMention,
  resolveWhatsAppGroupRequireMention,
} from "../channels/plugins/group-mentions.js";
export {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatch,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
} from "../channels/plugins/channel-config.js";
export {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "../channels/plugins/directory-config.js";
export type { AllowlistMatch } from "../channels/plugins/allowlist-match.js";
export { formatAllowlistMatchMeta } from "../channels/plugins/allowlist-match.js";
export {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../pairing/pairing-store.js";
export { resolveAgentRoute } from "../routing/resolve-route.js";
export {
  recordSessionMetaFromInbound,
  resolveStorePath,
  updateLastRoute,
} from "../config/sessions.js";
export { resolveStateDir } from "../config/paths.js";
export { loadConfig, writeConfigFile } from "../config/config.js";
export { optionalStringEnum, stringEnum } from "../agents/schema/typebox.js";
export { danger } from "../globals.js";
export { logVerbose, shouldLogVerbose } from "../globals.js";
export { getChildLogger } from "../logging.js";
export { enqueueSystemEvent } from "../infra/system-events.js";
export { runCommandWithTimeout } from "../process/exec.js";
export { loadWebMedia } from "../web/media.js";
export { isVoiceCompatibleAudio } from "../media/audio.js";
export { mediaKindFromMime } from "../media/constants.js";
export { detectMime } from "../media/mime.js";
export { getImageMetadata, resizeToJpeg } from "../media/image-ops.js";
export { saveMediaBuffer } from "../media/store.js";
export type { PollInput } from "../polls.js";

export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
  type ResolvedIMessageAccount,
} from "../imessage/accounts.js";
export { monitorIMessageProvider } from "../imessage/monitor.js";
export { probeIMessage } from "../imessage/probe.js";
export { sendMessageIMessage } from "../imessage/send.js";

export type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
} from "../channels/plugins/onboarding-types.js";
export { addWildcardAllowFrom, promptAccountId } from "../channels/plugins/onboarding/helpers.js";
export { promptChannelAccessConfig } from "../channels/plugins/onboarding/channel-access.js";
export { imessageOnboardingAdapter } from "../channels/plugins/onboarding/imessage.js";

export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "../agents/tools/common.js";
export { createMemoryGetTool, createMemorySearchTool } from "../agents/tools/memory-tool.js";
export { registerMemoryCli } from "../cli/memory-cli.js";

export { formatDocsLink } from "../terminal/links.js";
export type { HookEntry } from "../hooks/types.js";
export { registerPluginHooksFromDir } from "../hooks/plugin-hooks.js";
export { normalizeE164 } from "../utils.js";
export { missingTargetError } from "../infra/outbound/target-errors.js";

// Channel: Discord
export {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "../discord/accounts.js";
export { auditDiscordChannelPermissions, collectDiscordAuditChannelIds } from "../discord/audit.js";
export {
  listDiscordDirectoryGroupsLive,
  listDiscordDirectoryPeersLive,
} from "../discord/directory-live.js";
export { probeDiscord } from "../discord/probe.js";
export { resolveDiscordChannelAllowlist } from "../discord/resolve-channels.js";
export { resolveDiscordUserAllowlist } from "../discord/resolve-users.js";
export { sendMessageDiscord, sendPollDiscord } from "../discord/send.js";
export { monitorDiscordProvider } from "../discord/monitor.js";
export { discordMessageActions } from "../channels/plugins/actions/discord.js";
export { discordOnboardingAdapter } from "../channels/plugins/onboarding/discord.js";
export {
  looksLikeDiscordTargetId,
  normalizeDiscordMessagingTarget,
} from "../channels/plugins/normalize/discord.js";
export { collectDiscordStatusIssues } from "../channels/plugins/status-issues/discord.js";

// Channel: Slack
export {
  listEnabledSlackAccounts,
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  type ResolvedSlackAccount,
} from "../slack/accounts.js";
export {
  listSlackDirectoryGroupsLive,
  listSlackDirectoryPeersLive,
} from "../slack/directory-live.js";
export { probeSlack } from "../slack/probe.js";
export { resolveSlackChannelAllowlist } from "../slack/resolve-channels.js";
export { resolveSlackUserAllowlist } from "../slack/resolve-users.js";
export { sendMessageSlack } from "../slack/send.js";
export { monitorSlackProvider } from "../slack/index.js";
export { handleSlackAction } from "../agents/tools/slack-actions.js";
export { slackOnboardingAdapter } from "../channels/plugins/onboarding/slack.js";
export {
  looksLikeSlackTargetId,
  normalizeSlackMessagingTarget,
} from "../channels/plugins/normalize/slack.js";

// Channel: Telegram
export {
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  type ResolvedTelegramAccount,
} from "../telegram/accounts.js";
export {
  auditTelegramGroupMembership,
  collectTelegramUnmentionedGroupIds,
} from "../telegram/audit.js";
export { probeTelegram } from "../telegram/probe.js";
export { resolveTelegramToken } from "../telegram/token.js";
export { sendMessageTelegram } from "../telegram/send.js";
export { monitorTelegramProvider } from "../telegram/monitor.js";
export { telegramMessageActions } from "../channels/plugins/actions/telegram.js";
export { telegramOnboardingAdapter } from "../channels/plugins/onboarding/telegram.js";
export {
  looksLikeTelegramTargetId,
  normalizeTelegramMessagingTarget,
} from "../channels/plugins/normalize/telegram.js";
export { collectTelegramStatusIssues } from "../channels/plugins/status-issues/telegram.js";

// Channel: Signal
export {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  type ResolvedSignalAccount,
} from "../signal/accounts.js";
export { probeSignal } from "../signal/probe.js";
export { sendMessageSignal } from "../signal/send.js";
export { monitorSignalProvider } from "../signal/index.js";
export { signalOnboardingAdapter } from "../channels/plugins/onboarding/signal.js";
export {
  looksLikeSignalTargetId,
  normalizeSignalMessagingTarget,
} from "../channels/plugins/normalize/signal.js";

// Channel: WhatsApp
export {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  type ResolvedWhatsAppAccount,
} from "../web/accounts.js";
export { getActiveWebListener } from "../web/active-listener.js";
export {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  readWebSelfId,
  webAuthExists,
} from "../web/auth-store.js";
export { sendMessageWhatsApp, sendPollWhatsApp } from "../web/outbound.js";
export { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "../whatsapp/normalize.js";
export { loginWeb } from "../web/login.js";
export { startWebLoginWithQr, waitForWebLogin } from "../web/login-qr.js";
export { monitorWebChannel } from "../channels/web/index.js";
export { handleWhatsAppAction } from "../agents/tools/whatsapp-actions.js";
export { createWhatsAppLoginTool } from "../channels/plugins/agent-tools/whatsapp-login.js";
export { whatsappOnboardingAdapter } from "../channels/plugins/onboarding/whatsapp.js";
export { resolveWhatsAppHeartbeatRecipients } from "../channels/plugins/whatsapp-heartbeat.js";
export {
  looksLikeWhatsAppTargetId,
  normalizeWhatsAppMessagingTarget,
} from "../channels/plugins/normalize/whatsapp.js";
export { collectWhatsAppStatusIssues } from "../channels/plugins/status-issues/whatsapp.js";
