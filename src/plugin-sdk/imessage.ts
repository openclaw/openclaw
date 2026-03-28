export type { IMessageAccountConfig } from "../config/types.js";
export type { IMessageProbe } from "./imessage-runtime.js";
export type { OpenClawConfig } from "../config/config.js";
export type {
  ChannelMessageActionContext,
  ChannelPlugin,
  OpenClawPluginApi,
  PluginRuntime,
} from "./channel-plugin-common.js";
export {
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  deleteAccountFromConfigSection,
  emptyPluginConfigSchema,
  formatPairingApproveHint,
  getChatChannelMeta,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
} from "./channel-plugin-common.js";
export { detectBinary } from "../plugins/setup-binary.js";
export { formatDocsLink } from "../terminal/links.js";
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
  parseChatAllowTargetPrefixes,
  parseChatTargetPrefixesOrThrow,
  resolveServicePrefixedAllowTarget,
  resolveServicePrefixedTarget,
  type ParsedChatTarget,
} from "./imessage-targets.js";

export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "../config/runtime-group-policy.js";
export {
  normalizeIMessageHandle,
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "./imessage-policy.js";
export { __testing as iMessageConversationBindingTesting } from "../../extensions/imessage/api.js";
export { IMessageConfigSchema } from "../config/zod-schema.providers-core.js";

export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export { chunkTextForOutbound } from "./text-chunking.js";
export {
  buildComputedAccountStatusSnapshot,
  collectStatusIssuesFromLastError,
} from "./status-helpers.js";
export { monitorIMessageProvider, probeIMessage, sendMessageIMessage } from "./imessage-runtime.js";
