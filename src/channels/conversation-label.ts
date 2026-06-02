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
  // Channel From values are often provider:scope:id; the final segment is the only stable
  // disambiguator shared across channels for generic group labels.
  const parts = trimmed.split(":").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : trimmed;
}

function shouldAppendId(id: string): boolean {
  // Append only ids that are opaque enough to disambiguate generic labels without making
  // human-readable room names noisy.
  if (/^[0-9]+$/.test(id)) {
    return true;
  }
  if (/^[^\s:@]+@[^\s:@]+$/.test(id)) {
    return true;
  }
  return false;
}

/** Resolves a concise conversation label for session lists, logs, and route summaries. */
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
  if (!id) {
    return base;
  }
  if (!shouldAppendId(id)) {
    return base;
  }
  if (base === id) {
    return base;
  }
  if (base.includes(id)) {
    return base;
  }
  if (normalizeLowercaseStringOrEmpty(base).includes(" id:")) {
    return base;
  }
  if (base.startsWith("#") || base.startsWith("@")) {
    return base;
  }
  // Numeric and address-like ids disambiguate generic group labels, but avoid appending them to
  // explicit handles/channels or labels that already carry an id.
  return `${base} id:${id}`;
}
