import type { MsgContext } from "../auto-reply/templating.js";
import { normalizeChatType } from "./chat-type.js";

export function validateSenderIdentity(ctx: MsgContext): string[] {
  const issues: string[] = [];

  const chatType = normalizeChatType(ctx.ChatType);
  const isDirect = chatType === "direct";

  const senderId = ctx.SenderId?.trim() || "";
  const senderName = ctx.SenderName?.trim() || "";
  const senderUsername = ctx.SenderUsername?.trim() || "";
  const senderE164 = ctx.SenderE164?.trim() || "";

  if (!isDirect) {
    if (!senderId && !senderName && !senderUsername && !senderE164) {
      issues.push("missing sender identity (SenderId/SenderName/SenderUsername/SenderE164)");
    }
  }

  if (senderE164) {
    if (!/^\+\d{3,}$/.test(senderE164)) {
      issues.push(`invalid SenderE164: ${senderE164}`);
    }
  }

  if (senderUsername) {
    if (senderUsername.includes("@")) {
      issues.push(`SenderUsername should not include "@": ${senderUsername}`);
    }
    if (/\s/.test(senderUsername)) {
      issues.push(`SenderUsername should not include whitespace: ${senderUsername}`);
    }
  }

  if (ctx.SenderId != null && !senderId) {
    issues.push("SenderId is set but empty");
  }

  return issues;
}
