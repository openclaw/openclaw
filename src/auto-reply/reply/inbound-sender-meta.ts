import type { MsgContext } from "../templating.js";

export function formatInboundBodyWithSenderMeta(params: {
  body: string;
  ctx: MsgContext;
}): string {
  const body = params.body;
  if (!body.trim()) return body;
  const chatType = params.ctx.ChatType?.trim().toLowerCase();
  if (!chatType || chatType === "direct") return body;
  if (hasSenderMetaLine(body)) return body;

  const senderLabel = formatSenderLabel(params.ctx);
  if (!senderLabel) return body;

  const lineBreak = resolveBodyLineBreak(body);
  return `${body}${lineBreak}[from: ${senderLabel}]`;
}

function resolveBodyLineBreak(body: string): string {
  const hasEscaped = body.includes("\\n");
  const hasNewline = body.includes("\n");
  if (hasEscaped && !hasNewline) return "\\n";
  return "\n";
}

function hasSenderMetaLine(body: string): boolean {
  return /(^|\n|\\n)\[from:/i.test(body);
}

function formatSenderLabel(ctx: MsgContext): string | null {
  const senderName = ctx.SenderName?.trim();
  const senderId = (ctx.SenderE164?.trim() || ctx.SenderId?.trim()) ?? "";
  if (senderName && senderId && senderName !== senderId) {
    return `${senderName} (${senderId})`;
  }
  return senderName ?? (senderId || null);
}
