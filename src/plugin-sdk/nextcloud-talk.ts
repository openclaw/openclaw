// Narrow plugin-sdk surface for the bundled nextcloud-talk plugin.
// Keep this list additive and scoped to symbols used under extensions/nextcloud-talk.

export { logInboundDrop } from "../channels/logging.js";
export { resolveMentionGatingWithBypass } from "../channels/mention-gating.js";
export type { AllowlistMatch } from "../channels/plugins/allowlist-match.js";
export {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
} from "../channels/plugins/channel-config.js";
export {
  deleteAccountFromConfigSection,
  clearAccountEntryFields,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
} from "../channels/plugins/onboarding-types.js";
export {
  buildSingleChannelSecretPromptState,
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  promptAccountId,
  promptSingleChannelSecretInput,
  resolveAccountIdForConfigure,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "../channels/plugins/onboarding/helpers.js";
export {
  applyAccountNameToChannelSection,
  patchScopedAccountConfig,
} from "../channels/plugins/setup-helpers.js";
export { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
export type { ChannelGroupContext, ChannelSetupInput } from "../channels/plugins/types.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createReplyPrefixOptions } from "../channels/reply-prefix.js";
export type { OpenClawConfig } from "../config/config.js";
export { mapAllowFromEntries } from "./channel-config-helpers.js";
export { evaluateMatchedGroupAccessForPolicy } from "./group-access.js";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyConfig,
} from "../config/types.js";
export type { SecretInput } from "../config/types.secrets.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
export { buildSecretInputSchema } from "./secret-input-schema.js";
export { ToolPolicySchema } from "../config/zod-schema.agent-runtime.js";
export {
  BlockStreamingCoalesceSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  requireOpenAllowFrom,
} from "../config/zod-schema.core.js";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";
export { waitForAbortSignal } from "../infra/abort-signal.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithCommandGate,
} from "../security/dm-policy-shared.js";
export { formatDocsLink } from "../terminal/links.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export {
  listConfiguredAccountIds,
  resolveAccountWithDefaultFallback,
} from "./account-resolution.js";
export { createScopedPairingAccess } from "./pairing-access.js";
export { issuePairingChallenge } from "../pairing/pairing-challenge.js";
export { createPersistentDedupe } from "./persistent-dedupe.js";
export type { OutboundReplyPayload } from "./reply-payload.js";
export {
  createNormalizedOutboundDeliverer,
  formatTextWithAttachmentLinks,
  resolveOutboundMediaUrls,
} from "./reply-payload.js";
export { dispatchInboundReplyWithBase } from "./inbound-reply-dispatch.js";
export { createLoggerBackedRuntime } from "./runtime.js";
export {
  buildBaseChannelStatusSummary,
  buildRuntimeAccountStatusSnapshot,
} from "./status-helpers.js";
