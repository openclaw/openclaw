import type { MsgContext } from "../templating.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { listSenderLabelCandidates, resolveSenderLabel } from "../../channels/sender-label.js";

export function formatInboundBodyWithSenderMeta(params: { body: string; ctx: MsgContext }): string {
  const body = params.body;
  if (!body.trim()) return body;
  const chatType = normalizeChatType(params.ctx.ChatType);
  if (!chatType || chatType === "direct") return body;
  if (hasSenderMetaLine(body, params.ctx)) return body;

  const senderLabel = resolveSenderLabel({
    name: params.ctx.SenderName,
    username: params.ctx.SenderUsername,
    tag: params.ctx.SenderTag,
    e164: params.ctx.SenderE164,
    id: params.ctx.SenderId,
  });
  if (!senderLabel) return body;

  return `${body}\n[from: ${senderLabel}]`;
}

function hasSenderMetaLine(body: string, ctx: MsgContext): boolean {
  if (/(^|\n)\[from:/i.test(body)) return true;
  const candidates = listSenderLabelCandidates({
    name: ctx.SenderName,
    username: ctx.SenderUsername,
    tag: ctx.SenderTag,
    e164: ctx.SenderE164,
    id: ctx.SenderId,
  });
  if (candidates.length === 0) return false;
  return candidates.some((candidate) => {
    const escaped = escapeRegExp(candidate);
    // Envelope bodies look like "[Signal ...] Alice: hi".
    // Treat the post-header sender prefix as already having sender metadata.
    const pattern = new RegExp(`(^|\\n|\\]\\s*)${escaped}:\\s`, "i");
    return pattern.test(body);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
