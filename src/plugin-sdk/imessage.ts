export type { ResolvedIMessageAccount } from "../imessage/accounts.js";
export * from "./channel-plugin-common.js";
export {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
} from "../imessage/accounts.js";
export {
  formatTrimmedAllowFromEntries,
  resolveIMessageConfigAllowFrom,
  resolveIMessageConfigDefaultTo,
} from "./channel-config-helpers.js";
export {
  looksLikeIMessageTargetId,
  normalizeIMessageMessagingTarget,
} from "../channels/plugins/normalize/imessage.js";

export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "../config/runtime-group-policy.js";
export {
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "../channels/plugins/group-mentions.js";
export { imessageOnboardingAdapter } from "../channels/plugins/onboarding/imessage.js";
export { IMessageConfigSchema } from "../config/zod-schema.providers-core.js";

export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export { collectStatusIssuesFromLastError } from "./status-helpers.js";
