import type { ChunkMode } from "../auto-reply/chunk.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { loadWebMedia } from "../web/media.js";
import { chunkDiscordTextWithMode } from "./chunk.js";
import type { DiscordSendResult } from "./send.types.js";

const DISCORD_TEXT_LIMIT = 2000;

export type DiscordWebhookSendOpts = {
  username?: string;
  avatarUrl?: string;
  mediaUrl?: string;
  replyTo?: string;
  maxLinesPerMessage?: number;
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
  const url = webhookUrl.includes("?") ? `${webhookUrl}&wait=true` : `${webhookUrl}?wait=true`;

  let response: Response;

  if (file) {
    const formData = new FormData();
    formData.append("payload_json", JSON.stringify(payload));
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

export async function sendDiscordWebhook(
  webhookUrl: string,
  text: string,
  opts: DiscordWebhookSendOpts = {},
): Promise<DiscordSendResult> {
  const { username, avatarUrl, mediaUrl, replyTo, maxLinesPerMessage, chunkMode } = opts;

  const messageReference = replyTo ? { message_id: replyTo, fail_if_not_exists: false } : undefined;

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

    for (const chunk of chunks.slice(1)) {
      if (!chunk.trim()) {
        continue;
      }
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

export type DiscordWebhookMessageOpts = {
  webhookId: string;
  webhookToken: string;
  accountId?: string;
  threadId?: string;
  replyTo?: string;
  username?: string;
  avatarUrl?: string;
  maxLinesPerMessage?: number;
  chunkMode?: ChunkMode;
};

export async function sendWebhookMessageDiscord(
  text: string,
  opts: DiscordWebhookMessageOpts,
): Promise<DiscordSendResult> {
  const {
    webhookId,
    webhookToken,
    accountId,
    threadId,
    replyTo,
    username,
    avatarUrl,
    maxLinesPerMessage,
    chunkMode,
  } = opts;
  const baseUrl = `https://discord.com/api/webhooks/${webhookId}/${webhookToken}`;
  const webhookUrl = threadId ? `${baseUrl}?thread_id=${threadId}` : baseUrl;
  const result = await sendDiscordWebhook(webhookUrl, text, {
    username,
    avatarUrl,
    replyTo,
    maxLinesPerMessage,
    chunkMode,
  });
  if (accountId) {
    recordChannelActivity({
      channel: "discord",
      accountId,
      direction: "outbound",
    });
  }
  return result;
}
