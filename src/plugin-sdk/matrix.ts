// Narrow plugin-sdk surface for the bundled matrix plugin.
// Keep this list additive and scoped to symbols used under extensions/matrix.

export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringArrayParam,
  readStringParam,
} from "../agents/tools/common.js";
export type { ReplyPayload } from "../auto-reply/types.js";
export { resolveAckReaction } from "../agents/identity.js";
export {
  resolveConfiguredAcpRoute,
  ensureConfiguredAcpRouteReady,
} from "../acp/persistent-bindings.route.js";
export { resolveAllowlistMatchByCandidates } from "../channels/allowlist-match.js";
export {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  canonicalizeAllowlistWithResolvedIds,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "../channels/allowlists/resolve-utils.js";
export { resolveControlCommandGate } from "../channels/command-gating.js";
export type { NormalizedLocation } from "../channels/location.js";
export { formatLocationText, toLocationContext } from "../channels/location.js";
export { logInboundDrop, logTypingFailure } from "../channels/logging.js";
export type { AllowlistMatch } from "../channels/plugins/allowlist-match.js";
export { formatAllowlistMatchMeta } from "../channels/plugins/allowlist-match.js";
export {
  buildChannelKeyCandidates,
  resolveChannelEntryMatch,
} from "../channels/plugins/channel-config.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
} from "../channels/plugins/onboarding-types.js";
export { promptChannelAccessConfig } from "../channels/plugins/onboarding/channel-access.js";
export {
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  promptAccountId,
} from "../channels/plugins/onboarding/helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export {
  applyAccountNameToChannelSection,
  moveSingleAccountChannelSectionToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
export type {
  BaseProbeResult,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelOutboundAdapter,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelSetupInput,
  ChannelToolSend,
} from "../channels/plugins/types.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createReplyPrefixOptions } from "../channels/reply-prefix.js";
export { resolveThreadBindingFarewellText } from "../channels/thread-bindings-messages.js";
export {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../channels/thread-bindings-policy.js";
export { createTypingCallbacks } from "../channels/typing.js";
export type { OpenClawConfig } from "../config/config.js";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export type {
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyConfig,
  MarkdownTableMode,
} from "../config/types.js";
export type { SecretInput } from "../config/types.secrets.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
export { buildSecretInputSchema } from "./secret-input-schema.js";
export { ToolPolicySchema } from "../config/zod-schema.agent-runtime.js";
export { MarkdownConfigSchema } from "../config/zod-schema.core.js";
export { formatZonedTimestamp } from "../infra/format-time/format-datetime.js";
export {
  resolveMatrixAccountStorageRoot,
  resolveMatrixCredentialsDir,
  resolveMatrixCredentialsPath,
  resolveMatrixLegacyFlatStoragePaths,
} from "../infra/matrix-storage-paths.js";
export {
  requiresExplicitMatrixDefaultAccount,
  resolveMatrixDefaultOrOnlyAccountId,
} from "../infra/matrix-account-selection.js";
export { maybeCreateMatrixMigrationSnapshot } from "../infra/matrix-migration-snapshot.js";
export { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
export { isPrivateOrLoopbackHost } from "../gateway/net.js";
export {
  getSessionBindingService,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";
export type {
  BindingTargetKind,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export type { PollInput } from "../polls.js";
export { normalizePollInput } from "../polls.js";
export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export { normalizeStringEntries } from "../shared/string-normalization.js";
export { formatDocsLink } from "../terminal/links.js";
export { redactSensitiveText } from "../logging/redact.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { readJsonFileWithFallback, writeJsonFileAtomically } from "./json-store.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
