/**
 * High-level send helper for LINQ outbound messages.
 * Mirrors the pattern of src/imessage/send.ts.
 */

import { LinqClient, type LinqMessagePart } from "./client.js";

export type LinqSendOptions = {
  mediaUrl?: string;
  maxBytes?: number;
  accountId?: string;
  apiToken: string;
  fromNumber: string;
  preferredService?: "iMessage" | "RCS" | "SMS";
  replyToId?: string;
  effect?: { type: "screen" | "bubble"; name: string };
};

export type LinqSendResult = {
  ok: boolean;
  messageId?: string;
  chatId?: string;
  error?: string;
};

/**
 * Send a message to a LINQ target (phone number, email, or chat UUID).
 */
export async function sendMessageLinq(
  to: string,
  text: string,
  options: LinqSendOptions,
): Promise<LinqSendResult> {
  const client = new LinqClient(options.apiToken);
  const target = to.replace(/^linq:/, "");

  const parts: LinqMessagePart[] = [];
  if (options.mediaUrl) {
    parts.push({ type: "media", url: options.mediaUrl });
  }
  if (text) {
    parts.push({ type: "text", value: text });
  }
  if (parts.length === 0) {
    return { ok: false, error: "No content to send" };
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);

  try {
    if (isUuid) {
      // Send to existing chat
      const result = await client.sendMessage(target, {
        parts,
        ...(options.replyToId ? { reply_to: { message_id: options.replyToId } } : {}),
        ...(options.preferredService ? { preferred_service: options.preferredService } : {}),
        ...(options.effect ? { effect: options.effect } : {}),
      });
      return { ok: true, messageId: result.message.id, chatId: result.chat_id };
    }

    // Create chat and send
    const result = await client.createChat({
      from: options.fromNumber,
      to: [target],
      message: {
        parts,
        ...(options.preferredService ? { preferred_service: options.preferredService } : {}),
        ...(options.effect ? { effect: options.effect } : {}),
      },
    });
    return { ok: true, messageId: result.message.id, chatId: result.chat.id };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
