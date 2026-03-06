import type { PendingResponse } from "./confirming-store.js";

export function buildConfirmingNotification(params: {
  code: string;
  senderId: string;
  senderName?: string;
  originalMessage: string;
  suggestedResponse: string;
  includeMessage?: boolean;
}): string {
  const senderDisplay = params.senderName
    ? `${params.senderName} (${params.senderId})`
    : params.senderId;

  const includeMessage = params.includeMessage !== false;
  const messageSection = includeMessage ? `\n📝 *Message:*\n"${params.originalMessage}"\n` : "";

  return [
    `📩 *New message awaiting approval*`,
    ``,
    `From: ${senderDisplay}`,
    `Code: \`${params.code}\``,
    messageSection,
    `💬 *Suggested response:*`,
    `"${params.suggestedResponse}"`,
    ``,
    `✅ Approve: \`openclaw confirming approve whatsapp ${params.code}\``,
    `✏️ Edit: \`openclaw confirming edit whatsapp ${params.code} "your edited response"\``,
    `❌ Reject: \`openclaw confirming reject whatsapp ${params.code}\``,
  ].join("\n");
}

export function buildConfirmingApprovedNotification(params: {
  code: string;
  senderId: string;
  senderName?: string;
  editedResponse?: string;
}): string {
  const senderDisplay = params.senderName
    ? `${params.senderName} (${params.senderId})`
    : params.senderId;

  const editNote = params.editedResponse ? " (edited)" : "";

  return [
    `✅ *Response approved${editNote}*`,
    ``,
    `To: ${senderDisplay}`,
    `Code: \`${params.code}\``,
    ``,
    `Message has been sent.`,
  ].join("\n");
}

export function buildConfirmingRejectedNotification(params: {
  code: string;
  senderId: string;
  senderName?: string;
}): string {
  const senderDisplay = params.senderName
    ? `${params.senderName} (${params.senderId})`
    : params.senderId;

  return [
    `❌ *Response rejected*`,
    ``,
    `To: ${senderDisplay}`,
    `Code: \`${params.code}\``,
    ``,
    `No message was sent to the sender.`,
  ].join("\n");
}

export function buildConfirmingAckReply(): string {
  return [
    `Thanks for your message! 📨`,
    ``,
    `I've received it and will get back to you shortly.`,
  ].join("\n");
}

export function formatPendingResponsesList(responses: PendingResponse[]): string {
  if (responses.length === 0) {
    return "No pending responses.";
  }

  const pending = responses.filter((r) => r.status === "pending");
  if (pending.length === 0) {
    return "No pending responses.";
  }

  const lines = pending.map((r) => {
    const senderDisplay = r.senderName ? `${r.senderName} (${r.senderId})` : r.senderId;
    const preview =
      r.originalMessage.length > 50 ? `${r.originalMessage.slice(0, 50)}...` : r.originalMessage;
    return `• \`${r.code}\` from ${senderDisplay}: "${preview}"`;
  });

  return [`*Pending responses (${pending.length}):*`, "", ...lines].join("\n");
}
