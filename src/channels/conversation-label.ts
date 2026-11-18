import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../auto-reply/templating.js";
import { normalizeChatType } from "./chat-type.js";

function extractConversationId(from?: string): string | undefined {
  const trimmed = normalizeOptionalString(from);
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split(":").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : trimmed;
}

// Numeric ids and address-like ids are useful disambiguators. Human labels, hashtags,
// and handles are already readable enough and should not get redundant "id:" suffixes.
function shouldAppendId(id: string): boolean {
  return /^[0-9]+$/.test(id) || /^[^\s:@]+@[^\s:@]+$/.test(id);
}

export function resolveConversationLabel(ctx: MsgContext): string | undefined {
  const explicit = normalizeOptionalString(ctx.ConversationLabel);
  if (explicit) {
    return explicit;
  }

  const threadLabel = normalizeOptionalString(ctx.ThreadLabel);
  if (threadLabel) {
    return threadLabel;
  }

  const chatType = normalizeChatType(ctx.ChatType);
  if (chatType === "direct") {
    return normalizeOptionalString(ctx.SenderName) ?? normalizeOptionalString(ctx.From);
  }

  const base =
    normalizeOptionalString(ctx.GroupChannel) ||
    normalizeOptionalString(ctx.GroupSubject) ||
    normalizeOptionalString(ctx.GroupSpace) ||
    normalizeOptionalString(ctx.From) ||
    "";
  if (!base) {
    return undefined;
  }

  const id = extractConversationId(ctx.From);
  if (
    !id ||
    !shouldAppendId(id) ||
    base.includes(id) ||
    normalizeLowercaseStringOrEmpty(base).includes(" id:") ||
    base.startsWith("#") ||
    base.startsWith("@")
  ) {
    return base;
  }
  return `${base} id:${id}`;
}
