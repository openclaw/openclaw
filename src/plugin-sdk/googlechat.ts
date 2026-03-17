// Narrow plugin-sdk surface for the bundled googlechat plugin.
// Keep this list additive and scoped to symbols used under extensions/googlechat.

export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "../agents/tools/common.js";
export { resolveMentionGatingWithBypass } from "../channels/mention-gating.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export {
  listDirectoryGroupEntriesFromMapKeys,
  listDirectoryUserEntriesFromAllowFrom,
} from "../channels/plugins/directory-config-helpers.js";
export { buildComputedAccountStatusSnapshot } from "./status-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { createAccountStatusSink, runPassiveAccountLifecycle } from "./channel-lifecycle.js";
export { resolveGoogleChatGroupRequireMention } from "../channels/plugins/group-mentions.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export {
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  splitSetupEntries,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "../channels/plugins/setup-wizard-helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
export { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
export type {
  ChannelAccountSnapshot,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelStatusIssue,
} from "../channels/plugins/types.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { getChatChannelMeta } from "../channels/registry.js";
export { createReplyPrefixOptions } from "../channels/reply-prefix.js";
export type { OpenClawConfig } from "../config/config.js";
export { isDangerousNameMatchingEnabled } from "../config/dangerous-name-matching.js";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export type { DmPolicy, GoogleChatAccountConfig, GoogleChatConfig } from "../config/types.js";
export { isSecretRef } from "../config/types.secrets.js";
export { GoogleChatConfigSchema } from "../config/zod-schema.providers-core.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export { missingTargetError } from "../infra/outbound/target-errors.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export { resolveDmGroupAccessWithLists } from "../security/dm-policy-shared.js";
export { formatDocsLink } from "../terminal/links.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { googlechatSetupAdapter } from "../../extensions/googlechat/api.js";
export { googlechatSetupWizard } from "../../extensions/googlechat/api.js";
export { resolveInboundRouteEnvelopeBuilderWithRuntime } from "./inbound-envelope.js";
export { createScopedPairingAccess } from "./pairing-access.js";
export { issuePairingChallenge } from "../pairing/pairing-challenge.js";
export {
  evaluateGroupRouteAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "./group-access.js";
export { extractToolSend } from "./tool-send.js";
export { resolveWebhookPath } from "./webhook-path.js";
export type { WebhookInFlightLimiter } from "./webhook-request-guards.js";
export {
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
} from "./webhook-request-guards.js";
export {
  registerWebhookTargetWithPluginRoute,
  resolveWebhookTargets,
  resolveWebhookTargetWithAuthOrReject,
  withResolvedWebhookRequestPipeline,
} from "./webhook-targets.js";
