// Narrow plugin-sdk surface for the bundled bluebubbles plugin.
// Keep this list additive and scoped to symbols used under extensions/bluebubbles.

export { resolveAckReaction } from "../agents/identity.js";
export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "../agents/tools/common.js";
export type { HistoryEntry } from "../auto-reply/reply/history.js";
export {
  evictOldHistoryKeys,
  recordPendingHistoryEntryIfEnabled,
} from "../auto-reply/reply/history.js";
export { resolveControlCommandGate } from "../channels/command-gating.js";
export { logAckFailure, logInboundDrop, logTypingFailure } from "../channels/logging.js";
export {
  BLUEBUBBLES_ACTION_NAMES,
  BLUEBUBBLES_ACTIONS,
} from "../channels/plugins/bluebubbles-actions.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export {
  resolveBlueBubblesGroupRequireMention,
  resolveBlueBubblesGroupToolPolicy,
} from "../channels/plugins/group-mentions.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
} from "../channels/plugins/onboarding-types.js";
export {
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  promptAccountId,
  resolveAccountIdForConfigure,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "../channels/plugins/onboarding/helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
  patchScopedAccountConfig,
} from "../channels/plugins/setup-helpers.js";
export { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
export { collectBlueBubblesStatusIssues } from "../channels/plugins/status-issues/bluebubbles.js";
export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "../channels/plugins/types.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createReplyPrefixOptions } from "../channels/reply-prefix.js";
export type { OpenClawConfig } from "../config/config.js";
export type { DmPolicy, GroupPolicy } from "../config/types.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
export { buildSecretInputSchema } from "./secret-input-schema.js";
export { ToolPolicySchema } from "../config/zod-schema.agent-runtime.js";
export { MarkdownConfigSchema } from "../config/zod-schema.core.js";
export type { ParsedChatTarget } from "../../extensions/imessage/src/target-parsing-helpers.js";
export {
  parseChatAllowTargetPrefixes,
  parseChatTargetPrefixesOrThrow,
  resolveServicePrefixedAllowTarget,
  resolveServicePrefixedTarget,
} from "../../extensions/imessage/src/target-parsing-helpers.js";
export { stripMarkdown } from "../line/markdown-to-line.js";
export { parseFiniteNumber } from "../infra/parse-finite-number.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export {
  DM_GROUP_ACCESS_REASON,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "../security/dm-policy-shared.js";
export { formatDocsLink } from "../terminal/links.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { isAllowedParsedChatSender } from "./allow-from.js";
export { readBooleanParam } from "./boolean-param.js";
export { mapAllowFromEntries } from "./channel-config-helpers.js";
export { createScopedPairingAccess } from "./pairing-access.js";
export { issuePairingChallenge } from "../pairing/pairing-challenge.js";
export { resolveRequestUrl } from "./request-url.js";
export {
  buildComputedAccountStatusSnapshot,
  buildProbeChannelStatusSummary,
} from "./status-helpers.js";
export { extractToolSend } from "./tool-send.js";
export { normalizeWebhookPath } from "./webhook-path.js";
export {
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  readWebhookBodyOrReject,
} from "./webhook-request-guards.js";
export {
  registerWebhookTargetWithPluginRoute,
  resolveWebhookTargets,
  resolveWebhookTargetWithAuthOrRejectSync,
  withResolvedWebhookRequestPipeline,
} from "./webhook-targets.js";
