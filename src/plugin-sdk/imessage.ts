import type { OpenClawConfig } from "../config/config.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

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
  createAllowedChatSenderMatcher,
  parseChatAllowTargetPrefixes,
  parseChatTargetPrefixesOrThrow,
  resolveServicePrefixedAllowTarget,
  resolveServicePrefixedChatTarget,
  resolveServicePrefixedOrChatAllowTarget,
  resolveServicePrefixedTarget,
  type ChatSenderAllowParams,
  type ParsedChatTarget,
} from "./channel-targets.js";

export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "../config/runtime-group-policy.js";
export {
  normalizeIMessageHandle,
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "./imessage-policy.js";
export { IMessageConfigSchema } from "../config/zod-schema.providers-core.js";

export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export { chunkTextForOutbound } from "./text-chunking.js";
export {
  buildComputedAccountStatusSnapshot,
  collectStatusIssuesFromLastError,
} from "./status-helpers.js";
export { monitorIMessageProvider, probeIMessage, sendMessageIMessage } from "./imessage-runtime.js";

export type IMessageConversationBindingManager = {
  stop: () => void;
};

type IMessageFacadeModule = {
  createIMessageConversationBindingManager: (params: {
    accountId?: string;
    cfg: OpenClawConfig;
  }) => IMessageConversationBindingManager;
  matchIMessageAcpConversation: (params: {
    bindingConversationId: string;
    conversationId: string;
  }) => { conversationId: string; matchPriority: number } | null;
  normalizeIMessageAcpConversationId: (conversationId: string) => { conversationId: string } | null;
  resolveIMessageConversationIdFromTarget: (target: string) => string | undefined;
};

function loadIMessageFacadeModule(): IMessageFacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<IMessageFacadeModule>({
    dirName: "imessage",
    artifactBasename: "api.js",
  });
}

export function createIMessageConversationBindingManager(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): IMessageConversationBindingManager {
  return loadIMessageFacadeModule().createIMessageConversationBindingManager(params);
}

export function normalizeIMessageAcpConversationId(
  conversationId: string,
): { conversationId: string } | null {
  return loadIMessageFacadeModule().normalizeIMessageAcpConversationId(conversationId);
}

export function matchIMessageAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
}): { conversationId: string; matchPriority: number } | null {
  return loadIMessageFacadeModule().matchIMessageAcpConversation(params);
}

export function resolveIMessageConversationIdFromTarget(target: string): string | undefined {
  return loadIMessageFacadeModule().resolveIMessageConversationIdFromTarget(target);
}
