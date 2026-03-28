import {
  normalizeIMessageHandle,
  parseChatAllowTargetPrefixes,
  parseChatTargetPrefixesOrThrow,
  resolveServicePrefixedAllowTarget,
  resolveServicePrefixedTarget,
  type ParsedChatTarget,
} from "./imessage-targets.js";

export type { ChannelPlugin } from "./channel-plugin-common.js";
export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  deleteAccountFromConfigSection,
  getChatChannelMeta,
  setAccountEnabledInConfigSection,
} from "./channel-plugin-common.js";
export {
  formatTrimmedAllowFromEntries,
  resolveIMessageConfigAllowFrom,
  resolveIMessageConfigDefaultTo,
} from "./channel-config-helpers.js";
export { IMessageConfigSchema } from "../config/zod-schema.providers-core.js";
export {
  normalizeIMessageHandle,
  parseChatAllowTargetPrefixes,
  parseChatTargetPrefixesOrThrow,
  resolveServicePrefixedAllowTarget,
  resolveServicePrefixedTarget,
  type ParsedChatTarget,
} from "./imessage-targets.js";

type IMessageService = "imessage" | "sms" | "auto";

type IMessageTarget = ParsedChatTarget | { kind: "handle"; to: string; service: IMessageService };

const CHAT_ID_PREFIXES = ["chat_id:", "chatid:", "chat:"];
const CHAT_GUID_PREFIXES = ["chat_guid:", "chatguid:", "guid:"];
const CHAT_IDENTIFIER_PREFIXES = ["chat_identifier:", "chatidentifier:", "chatident:"];
const SERVICE_PREFIXES: Array<{ prefix: string; service: IMessageService }> = [
  { prefix: "imessage:", service: "imessage" },
  { prefix: "sms:", service: "sms" },
  { prefix: "auto:", service: "auto" },
];

function startsWithAnyPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function parseIMessageTarget(raw: string): IMessageTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("iMessage target is required");
  }
  const lower = trimmed.toLowerCase();

  const servicePrefixed = resolveServicePrefixedTarget({
    trimmed,
    lower,
    servicePrefixes: SERVICE_PREFIXES,
    isChatTarget: (remainderLower) =>
      startsWithAnyPrefix(remainderLower, [
        ...CHAT_ID_PREFIXES,
        ...CHAT_GUID_PREFIXES,
        ...CHAT_IDENTIFIER_PREFIXES,
      ]),
    parseTarget: parseIMessageTarget,
  });
  if (servicePrefixed) {
    return servicePrefixed;
  }

  const chatTarget = parseChatTargetPrefixesOrThrow({
    trimmed,
    lower,
    chatIdPrefixes: CHAT_ID_PREFIXES,
    chatGuidPrefixes: CHAT_GUID_PREFIXES,
    chatIdentifierPrefixes: CHAT_IDENTIFIER_PREFIXES,
  });
  if (chatTarget) {
    return chatTarget;
  }

  return { kind: "handle", to: trimmed, service: "auto" };
}

export function normalizeIMessageAcpConversationId(
  conversationId: string,
): { conversationId: string } | null {
  const trimmed = conversationId.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = parseIMessageTarget(trimmed);
    if (parsed.kind === "handle") {
      const handle = normalizeIMessageHandle(parsed.to);
      return handle ? { conversationId: handle } : null;
    }
    if (parsed.kind === "chat_id") {
      return { conversationId: String(parsed.chatId) };
    }
    if (parsed.kind === "chat_guid") {
      return { conversationId: parsed.chatGuid };
    }
    return { conversationId: parsed.chatIdentifier };
  } catch {
    const handle = normalizeIMessageHandle(trimmed);
    return handle ? { conversationId: handle } : null;
  }
}

export function matchIMessageAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
}): { conversationId: string; matchPriority: number } | null {
  const binding = normalizeIMessageAcpConversationId(params.bindingConversationId);
  const conversation = normalizeIMessageAcpConversationId(params.conversationId);
  if (!binding || !conversation) {
    return null;
  }
  if (binding.conversationId !== conversation.conversationId) {
    return null;
  }
  return {
    conversationId: conversation.conversationId,
    matchPriority: 2,
  };
}

export function resolveIMessageConversationIdFromTarget(target: string): string | undefined {
  return normalizeIMessageAcpConversationId(target)?.conversationId;
}
