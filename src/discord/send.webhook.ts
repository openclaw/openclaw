import { serializePayload, type MessagePayloadFile, type RequestClient } from "@buape/carbon";
import type { ChunkMode } from "../auto-reply/chunk.js";
import { loadWebMedia } from "../web/media.js";
import { chunkDiscordTextWithMode } from "./chunk.js";
import { buildDiscordMessagePayload, stripUndefinedFields } from "./send.shared.js";

const DISCORD_WEBHOOK_TEXT_LIMIT = 2000;

type SendWebhookMessageOpts = {
  username?: string;
  avatarUrl?: string;
  rest: RequestClient;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  maxLinesPerMessage?: number;
  chunkMode?: ChunkMode;
};

function webhookExecuteUrl(webhookId: string, webhookToken: string) {
  return `/webhooks/${encodeURIComponent(webhookId)}/${encodeURIComponent(webhookToken)}?wait=true`;
}

function chunkWebhookText(
  text: string,
  opts: Pick<SendWebhookMessageOpts, "maxLinesPerMessage" | "chunkMode">,
): string[] {
  const chunks = chunkDiscordTextWithMode(text, {
    maxChars: DISCORD_WEBHOOK_TEXT_LIMIT,
    maxLines: opts.maxLinesPerMessage,
    chunkMode: opts.chunkMode,
  });
  if (!chunks.length && text) {
    chunks.push(text);
  }
  return chunks;
}

function buildWebhookMeta(opts: Pick<SendWebhookMessageOpts, "username" | "avatarUrl">) {
  return stripUndefinedFields({
    username: opts.username?.trim() || undefined,
    avatar_url: opts.avatarUrl?.trim() || undefined,
  });
}

async function executeWebhook(
  webhookId: string,
  webhookToken: string,
  body: Record<string, unknown>,
  rest: RequestClient,
) {
  await rest.post(webhookExecuteUrl(webhookId, webhookToken), { body });
}

async function buildWebhookFile(
  mediaUrl: string,
  mediaLocalRoots?: readonly string[],
): Promise<MessagePayloadFile> {
  const media = await loadWebMedia(mediaUrl, { localRoots: mediaLocalRoots });
  let data: Blob;
  if (media.buffer instanceof Blob) {
    data = media.buffer;
  } else {
    const arrayBuffer = new ArrayBuffer(media.buffer.byteLength);
    new Uint8Array(arrayBuffer).set(media.buffer);
    data = new Blob([arrayBuffer]);
  }
  return {
    data,
    name: media.fileName ?? "upload",
  };
}

export async function sendWebhookMessage(
  webhookId: string,
  webhookToken: string,
  text: string,
  opts: SendWebhookMessageOpts,
) {
  const meta = buildWebhookMeta(opts);
  const chunks = text ? chunkWebhookText(text, opts) : [];
  const trimmedChunks = chunks.map((chunk) => chunk.trim()).filter(Boolean);

  if (opts.mediaUrl) {
    const file = await buildWebhookFile(opts.mediaUrl, opts.mediaLocalRoots);
    const caption = trimmedChunks[0] ?? "";
    const payload = buildDiscordMessagePayload({
      text: caption,
      files: [file],
    });
    await executeWebhook(
      webhookId,
      webhookToken,
      stripUndefinedFields({
        ...serializePayload(payload),
        ...meta,
      }),
      opts.rest,
    );
    for (const chunk of trimmedChunks.slice(1)) {
      await executeWebhook(
        webhookId,
        webhookToken,
        stripUndefinedFields({
          content: chunk,
          ...meta,
        }),
        opts.rest,
      );
    }
    return;
  }

  if (trimmedChunks.length === 0) {
    return;
  }
  for (const chunk of trimmedChunks) {
    await executeWebhook(
      webhookId,
      webhookToken,
      stripUndefinedFields({
        content: chunk,
        ...meta,
      }),
      opts.rest,
    );
  }
}
