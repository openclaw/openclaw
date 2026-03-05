// Narrow plugin-sdk surface for the bundled mattermost plugin.
// Keep this list additive and scoped to symbols used under extensions/mattermost.

export { formatInboundFromLabel } from "../auto-reply/envelope.js";
export type { HistoryEntry } from "../auto-reply/reply/history.js";
export {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
} from "../auto-reply/reply/history.js";
export { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
export type { ReplyPayload } from "../auto-reply/types.js";
export type { ChatType } from "../channels/chat-type.js";
export { resolveControlCommandGate } from "../channels/command-gating.js";
export { logInboundDrop, logTypingFailure } from "../channels/logging.js";
export { resolveChannelGroupRequireMention } from "../config/group-policy.js";
export { resolveAllowlistMatchSimple } from "../channels/plugins/allowlist-match.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export type { ChannelOnboardingAdapter } from "../channels/plugins/onboarding-types.js";
export {
  promptAccountId,
  promptSingleChannelSecretInput,
} from "../channels/plugins/onboarding/helpers.js";
export {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "../channels/plugins/types.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createReplyPrefixOptions } from "../channels/reply-prefix.js";
export { createTypingCallbacks } from "../channels/typing.js";
export type { OpenClawConfig } from "../config/config.js";
export { isDangerousNameMatchingEnabled } from "../config/dangerous-name-matching.js";
export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export type { BlockStreamingCoalesceConfig, DmPolicy, GroupPolicy } from "../config/types.js";
export type { SecretInput } from "../config/types.secrets.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
export {
  BlockStreamingCoalesceSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  requireOpenAllowFrom,
} from "../config/zod-schema.core.js";
export { createDedupeCache } from "../infra/dedupe.js";
export { rawDataToString } from "../infra/ws.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveThreadSessionKeys,
} from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export {
  DM_GROUP_ACCESS_REASON,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
} from "../security/dm-policy-shared.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { buildAgentMediaPayload } from "./agent-media-payload.js";
export { loadOutboundMediaFromUrl } from "./outbound-media.js";
export { createScopedPairingAccess } from "./pairing-access.js";
