import { normalizeAccountId } from "../../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

export type ConversationRefShape = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};

export function normalizeConversationRef<T extends ConversationRefShape>(ref: T): T {
  return {
    ...ref,
    channel: normalizeLowercaseStringOrEmpty(ref.channel),
    accountId: normalizeAccountId(ref.accountId),
    conversationId: normalizeOptionalString(ref.conversationId) ?? "",
    parentConversationId: normalizeOptionalString(ref.parentConversationId),
  };
}

export function buildChannelAccountKey(params: { channel: string; accountId: string }): string {
  return `${normalizeLowercaseStringOrEmpty(params.channel)}:${normalizeAccountId(params.accountId)}`;
}
