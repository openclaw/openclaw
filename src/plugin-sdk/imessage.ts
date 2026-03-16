export type { ResolvedIMessageAccount } from "../../extensions/imessage/src/accounts.js";
export type { IMessageAccountConfig } from "../config/types.js";
export * from "./channel-plugin-common.js";
export {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
} from "../../extensions/imessage/src/accounts.js";
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
  createAllowedChatSenderMatcher,
  parseChatAllowTargetPrefixes,
  parseChatTargetPrefixesOrThrow,
  resolveServicePrefixedChatTarget,
  resolveServicePrefixedAllowTarget,
  resolveServicePrefixedOrChatAllowTarget,
  resolveServicePrefixedTarget,
} from "../../extensions/imessage/src/target-parsing-helpers.js";
export type {
  ChatSenderAllowParams,
  ParsedChatTarget,
} from "../../extensions/imessage/src/target-parsing-helpers.js";

export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "../config/runtime-group-policy.js";
export {
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "../channels/plugins/group-mentions.js";
export { imessageSetupWizard } from "../../extensions/imessage/src/setup-surface.js";
export { imessageSetupAdapter } from "../../extensions/imessage/src/setup-core.js";
export { IMessageConfigSchema } from "../config/zod-schema.providers-core.js";

export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export { collectStatusIssuesFromLastError } from "./status-helpers.js";
