import type { MsgContext } from "../templating.js";
import { normalizeChatType } from "../../channels/chat-type.js";

export function formatInboundBodyWithSenderMeta(params: { body: string; ctx: MsgContext }): string {
  const body = params.body;
  if (!body.trim()) return body;
  const chatType = normalizeChatType(params.ctx.ChatType);
  if (!chatType || chatType === "direct") return body;
  if (hasSenderMetaLine(body)) return body;

  const senderLabel = formatSenderLabel(params.ctx);
  if (!senderLabel) return body;

  return `${body}\n[from: ${senderLabel}]`;
}

function hasSenderMetaLine(body: string): boolean {
  return /(^|\n)\[from:/i.test(body);
}

function formatSenderLabel(ctx: MsgContext): string | null {
  const senderName = ctx.SenderName?.trim();
  const senderId = (ctx.SenderE164?.trim() || ctx.SenderId?.trim()) ?? "";
  if (senderName && senderId && senderName !== senderId) {
    return `${senderName} (${senderId})`;
  }
  return senderName ?? (senderId || null);
}
