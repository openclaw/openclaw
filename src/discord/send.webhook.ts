/**
 * Discord webhook message sender.
 *
 * Sends messages through Discord webhooks instead of the bot API.
 * This allows agents to have their own visual identity (name + avatar).
 */

import type { ChunkMode } from "../auto-reply/chunk.js";
import type { DiscordSendResult } from "./send.types.js";
import { loadWebMedia } from "../web/media.js";
import { chunkDiscordTextWithMode } from "./chunk.js";

const DISCORD_TEXT_LIMIT = 2000;

export type DiscordWebhookSendOpts = {
  /** Username to display for the webhook message. */
  username?: string;
  /** Avatar URL to display for the webhook message. */
  avatarUrl?: string;
  /** Media URL to attach to the message. */
  mediaUrl?: string;
  /** Reply to a specific message ID. */
  replyTo?: string;
  /** Max lines per message chunk. */
  maxLinesPerMessage?: number;
  /** Chunking mode. */
  chunkMode?: ChunkMode;
};

type WebhookPayload = {
  content?: string;
  username?: string;
  avatar_url?: string;
  message_reference?: { message_id: string; fail_if_not_exists: boolean };
};

type WebhookResponse = {
  id: string;
  channel_id: string;
};

async function executeWebhook(
  webhookUrl: string,
  payload: WebhookPayload,
  file?: { data: Buffer; name: string },
): Promise<WebhookResponse> {
  // Append ?wait=true to get the message back in the response
  const url = webhookUrl.includes("?") ? `${webhookUrl}&wait=true` : `${webhookUrl}?wait=true`;

  let response: Response;

  if (file) {
    // Use FormData for file uploads
    const formData = new FormData();
    formData.append("payload_json", JSON.stringify(payload));
    // Convert Buffer to ArrayBuffer for proper Blob compatibility
    const arrayBuffer = file.data.buffer.slice(
      file.data.byteOffset,
      file.data.byteOffset + file.data.byteLength,
    ) as ArrayBuffer;
    formData.append("file", new Blob([arrayBuffer]), file.name);

    response = await fetch(url, {
      method: "POST",
      body: formData,
    });
  } else {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(`Discord webhook failed (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as WebhookResponse;
  return result;
}

/**
 * Send a message through a Discord webhook.
 *
 * @param webhookUrl - The full Discord webhook URL
 * @param text - Message text to send
 * @param opts - Optional settings (username, avatar, media, etc.)
 * @returns Promise resolving to the send result with messageId and channelId
 */
export async function sendDiscordWebhook(
  webhookUrl: string,
  text: string,
  opts: DiscordWebhookSendOpts = {},
): Promise<DiscordSendResult> {
  const { username, avatarUrl, mediaUrl, replyTo, maxLinesPerMessage, chunkMode } = opts;

  const messageReference = replyTo ? { message_id: replyTo, fail_if_not_exists: false } : undefined;

  // Handle media attachment
  if (mediaUrl) {
    const media = await loadWebMedia(mediaUrl);
    const chunks = text
      ? chunkDiscordTextWithMode(text, {
          maxChars: DISCORD_TEXT_LIMIT,
          maxLines: maxLinesPerMessage,
          chunkMode,
        })
      : [];
    if (!chunks.length && text) {
      chunks.push(text);
    }

    const caption = chunks[0] ?? "";
    const payload: WebhookPayload = {
      content: caption || undefined,
      username,
      avatar_url: avatarUrl,
      message_reference: messageReference,
    };

    const result = await executeWebhook(webhookUrl, payload, {
      data: media.buffer,
      name: media.fileName ?? "upload",
    });

    // Send remaining text chunks
    for (const chunk of chunks.slice(1)) {
      if (!chunk.trim()) continue;
      await executeWebhook(webhookUrl, {
        content: chunk,
        username,
        avatar_url: avatarUrl,
      });
    }

    return {
      messageId: result.id,
      channelId: result.channel_id,
    };
  }

  // Text-only message
  if (!text.trim()) {
    throw new Error("Message must be non-empty for Discord webhook sends");
  }

  const chunks = chunkDiscordTextWithMode(text, {
    maxChars: DISCORD_TEXT_LIMIT,
    maxLines: maxLinesPerMessage,
    chunkMode,
  });
  if (!chunks.length && text) {
    chunks.push(text);
  }

  let lastResult: WebhookResponse | null = null;
  let isFirst = true;

  for (const chunk of chunks) {
    const payload: WebhookPayload = {
      content: chunk,
      username,
      avatar_url: avatarUrl,
      message_reference: isFirst ? messageReference : undefined,
    };

    lastResult = await executeWebhook(webhookUrl, payload);
    isFirst = false;
  }

  if (!lastResult) {
    throw new Error("Discord webhook send failed (empty chunk result)");
  }

  return {
    messageId: lastResult.id,
    channelId: lastResult.channel_id,
  };
}
