import type { ChannelOutboundAdapter } from "../types.js";
import { chunkText } from "../../../auto-reply/chunk.js";
import { LinqClient } from "../../../linq/client.js";
import type { LinqAccountConfig } from "../../../config/types.linq.js";
import { resolveLinqAccount } from "../../../linq/accounts.js";

function getLinqClient(cfg: unknown, accountId?: string | null): { client: LinqClient; fromNumber: string } {
  const account = resolveLinqAccount({ cfg: cfg as import("../../../config/config.js").OpenClawConfig, accountId });
  const token = account.config.apiToken;
  if (!token) {
    throw new Error("LINQ API token not configured");
  }
  const fromNumber = account.config.fromNumber;
  if (!fromNumber) {
    throw new Error("LINQ sender phone number (fromNumber) not configured");
  }
  return { client: new LinqClient(token), fromNumber };
}

export const linqOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, replyToId }) => {
    const { client, fromNumber } = getLinqClient(cfg, accountId);
    const account = resolveLinqAccount({ cfg: cfg as import("../../../config/config.js").OpenClawConfig, accountId });
    const preferredService = account.config.preferredService;

    // Resolve the target: could be a chat ID (UUID) or a phone number/email
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(to);

    if (isUuid) {
      // Send to existing chat by ID
      const result = await client.sendMessage(to, {
        parts: [{ type: "text", value: text }],
        ...(replyToId ? { reply_to: { message_id: replyToId } } : {}),
        ...(preferredService ? { preferred_service: preferredService } : {}),
      });
      return {
        channel: "linq",
        ok: true,
        messageId: result.message.id,
      };
    }

    // Create new chat and send initial message
    const target = to.replace(/^linq:/, "");
    const result = await client.createChat({
      from: fromNumber,
      to: [target],
      message: {
        parts: [{ type: "text", value: text }],
        ...(preferredService ? { preferred_service: preferredService } : {}),
      },
    });
    return {
      channel: "linq",
      ok: true,
      messageId: result.message.id,
      chatId: result.chat.id,
    };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => {
    const { client, fromNumber } = getLinqClient(cfg, accountId);
    const account = resolveLinqAccount({ cfg: cfg as import("../../../config/config.js").OpenClawConfig, accountId });
    const preferredService = account.config.preferredService;

    const parts: import("../../../linq/client.js").LinqMessagePart[] = [];
    if (mediaUrl) {
      parts.push({ type: "media", url: mediaUrl });
    }
    if (text) {
      parts.push({ type: "text", value: text });
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(to);

    if (isUuid) {
      const result = await client.sendMessage(to, {
        parts,
        ...(replyToId ? { reply_to: { message_id: replyToId } } : {}),
        ...(preferredService ? { preferred_service: preferredService } : {}),
      });
      return {
        channel: "linq",
        ok: true,
        messageId: result.message.id,
      };
    }

    const target = to.replace(/^linq:/, "");
    const result = await client.createChat({
      from: fromNumber,
      to: [target],
      message: {
        parts,
        ...(preferredService ? { preferred_service: preferredService } : {}),
      },
    });
    return {
      channel: "linq",
      ok: true,
      messageId: result.message.id,
      chatId: result.chat.id,
    };
  },
};
