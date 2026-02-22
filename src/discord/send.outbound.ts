import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { serializePayload, type MessagePayloadObject, type RequestClient } from "@buape/carbon";
import type { APIChannel } from "discord-api-types/v10";
import { ChannelType, Routes } from "discord-api-types/v10";
import { resolveChunkMode } from "../auto-reply/chunk.js";
import { loadConfig } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import type { RetryConfig } from "../infra/retry.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { convertMarkdownTables } from "../markdown/tables.js";
import { maxBytesForKind } from "../media/constants.js";
import { extensionForMime } from "../media/mime.js";
import type { PollInput } from "../polls.js";
import { loadWebMediaRaw } from "../web/media.js";
import { resolveDiscordAccount } from "./accounts.js";
import {
  buildDiscordMessagePayload,
  buildDiscordSendError,
  buildDiscordTextChunks,
  createDiscordClient,
  normalizeDiscordPollInput,
  normalizeStickerIds,
  parseAndResolveRecipient,
  resolveChannelId,
  resolveDiscordSendComponents,
  resolveDiscordSendEmbeds,
  sendDiscordMedia,
  sendDiscordText,
  stripUndefinedFields,
  SUPPRESS_NOTIFICATIONS_FLAG,
  type DiscordSendComponents,
  type DiscordSendEmbeds,
} from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";
import {
  ensureOggOpus,
  getVoiceMessageMetadata,
  sendDiscordVoiceMessage,
} from "./voice-message.js";

type DiscordSendOpts = {
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  verbose?: boolean;
  rest?: RequestClient;
  replyTo?: string;
  retry?: RetryConfig;
  components?: DiscordSendComponents;
  embeds?: DiscordSendEmbeds;
  silent?: boolean;
};

type DiscordClientRequest = ReturnType<typeof createDiscordClient>["request"];

type DiscordChannelMessageResult = {
  id?: string | null;
  channel_id?: string | null;
};

async function sendDiscordThreadTextChunks(params: {
  rest: RequestClient;
  threadId: string;
  chunks: readonly string[];
  request: DiscordClientRequest;
  maxLinesPerMessage?: number;
  chunkMode: ReturnType<typeof resolveChunkMode>;
  silent?: boolean;
}): Promise<void> {
  for (const chunk of params.chunks) {
    await sendDiscordText(
      params.rest,
      params.threadId,
      chunk,
      undefined,
      params.request,
      params.maxLinesPerMessage,
      undefined,
      undefined,
      params.chunkMode,
      params.silent,
    );
  }
}

/** Discord thread names are capped at 100 characters. */
const DISCORD_THREAD_NAME_LIMIT = 100;

/** Derive a thread title from the first non-empty line of the message text. */
function deriveForumThreadName(text: string): string {
  const firstLine =
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  return firstLine.slice(0, DISCORD_THREAD_NAME_LIMIT) || new Date().toISOString().slice(0, 16);
}

/** Forum/Media channels cannot receive regular messages; detect them here. */
function isForumLikeType(channelType?: number): boolean {
  return channelType === ChannelType.GuildForum || channelType === ChannelType.GuildMedia;
}

function toDiscordSendResult(
  result: DiscordChannelMessageResult,
  fallbackChannelId: string,
): DiscordSendResult {
  return {
    messageId: result.id ? String(result.id) : "unknown",
    channelId: String(result.channel_id ?? fallbackChannelId),
  };
}

async function resolveDiscordSendTarget(
  to: string,
  opts: DiscordSendOpts,
): Promise<{ rest: RequestClient; request: DiscordClientRequest; channelId: string }> {
  const cfg = loadConfig();
  const { rest, request } = createDiscordClient(opts, cfg);
  const recipient = await parseAndResolveRecipient(to, opts.accountId);
  const { channelId } = await resolveChannelId(rest, recipient, request);
  return { rest, request, channelId };
}

export async function sendMessageDiscord(
  to: string,
  text: string,
  opts: DiscordSendOpts = {},
): Promise<DiscordSendResult> {
  const cfg = loadConfig();
  const accountInfo = resolveDiscordAccount({
    cfg,
    accountId: opts.accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "discord",
    accountId: accountInfo.accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "discord", accountInfo.accountId);
  const textWithTables = convertMarkdownTables(text ?? "", tableMode);
  const { token, rest, request } = createDiscordClient(opts, cfg);
  const recipient = await parseAndResolveRecipient(to, opts.accountId);
  const { channelId } = await resolveChannelId(rest, recipient, request);

  // Forum/Media channels reject POST /messages; auto-create a thread post instead.
  let channelType: number | undefined;
  try {
    const channel = (await rest.get(Routes.channel(channelId))) as APIChannel | undefined;
    channelType = channel?.type;
  } catch {
    // If we can't fetch the channel, fall through to the normal send path.
  }

  if (isForumLikeType(channelType)) {
    const threadName = deriveForumThreadName(textWithTables);
    const chunks = buildDiscordTextChunks(textWithTables, {
      maxLinesPerMessage: accountInfo.config.maxLinesPerMessage,
      chunkMode,
    });
    const starterContent = chunks[0]?.trim() ? chunks[0] : threadName;
    const starterComponents = resolveDiscordSendComponents({
      components: opts.components,
      text: starterContent,
      isFirst: true,
    });
    const starterEmbeds = resolveDiscordSendEmbeds({ embeds: opts.embeds, isFirst: true });
    const silentFlags = opts.silent ? 1 << 12 : undefined;
    const starterPayload: MessagePayloadObject = buildDiscordMessagePayload({
      text: starterContent,
      components: starterComponents,
      embeds: starterEmbeds,
      flags: silentFlags,
    });
    let threadRes: { id: string; message?: { id: string; channel_id: string } };
    try {
      threadRes = (await request(
        () =>
          rest.post(Routes.threads(channelId), {
            body: {
              name: threadName,
              message: stripUndefinedFields(serializePayload(starterPayload)),
            },
          }) as Promise<{ id: string; message?: { id: string; channel_id: string } }>,
        "forum-thread",
      )) as { id: string; message?: { id: string; channel_id: string } };
    } catch (err) {
      throw await buildDiscordSendError(err, {
        channelId,
        rest,
        token,
        hasMedia: Boolean(opts.mediaUrl),
      });
    }

    const threadId = threadRes.id;
    const messageId = threadRes.message?.id ?? threadId;
    const resultChannelId = threadRes.message?.channel_id ?? threadId;
    const remainingChunks = chunks.slice(1);

    try {
      if (opts.mediaUrl) {
        const [mediaCaption, ...afterMediaChunks] = remainingChunks;
        await sendDiscordMedia(
          rest,
          threadId,
          mediaCaption ?? "",
          opts.mediaUrl,
          opts.mediaLocalRoots,
          undefined,
          request,
          accountInfo.config.maxLinesPerMessage,
          undefined,
          undefined,
          chunkMode,
          opts.silent,
        );
        await sendDiscordThreadTextChunks({
          rest,
          threadId,
          chunks: afterMediaChunks,
          request,
          maxLinesPerMessage: accountInfo.config.maxLinesPerMessage,
          chunkMode,
          silent: opts.silent,
        });
      } else {
        await sendDiscordThreadTextChunks({
          rest,
          threadId,
          chunks: remainingChunks,
          request,
          maxLinesPerMessage: accountInfo.config.maxLinesPerMessage,
          chunkMode,
          silent: opts.silent,
        });
      }
    } catch (err) {
      throw await buildDiscordSendError(err, {
        channelId: threadId,
        rest,
        token,
        hasMedia: Boolean(opts.mediaUrl),
      });
    }

    recordChannelActivity({
      channel: "discord",
      accountId: accountInfo.accountId,
      direction: "outbound",
    });
    return toDiscordSendResult(
      {
        id: messageId,
        channel_id: resultChannelId,
      },
      channelId,
    );
  }

  let result: { id: string; channel_id: string } | { id: string | null; channel_id: string };
  try {
    if (opts.mediaUrl) {
      result = await sendDiscordMedia(
        rest,
        channelId,
        textWithTables,
        opts.mediaUrl,
        opts.mediaLocalRoots,
        opts.replyTo,
        request,
        accountInfo.config.maxLinesPerMessage,
        opts.components,
        opts.embeds,
        chunkMode,
        opts.silent,
      );
    } else {
      result = await sendDiscordText(
        rest,
        channelId,
        textWithTables,
        opts.replyTo,
        request,
        accountInfo.config.maxLinesPerMessage,
        opts.components,
        opts.embeds,
        chunkMode,
        opts.silent,
      );
    }
  } catch (err) {
    throw await buildDiscordSendError(err, {
      channelId,
      rest,
      token,
      hasMedia: Boolean(opts.mediaUrl),
    });
  }

  recordChannelActivity({
    channel: "discord",
    accountId: accountInfo.accountId,
    direction: "outbound",
  });
  return toDiscordSendResult(result, channelId);
}

type DiscordWebhookSendOpts = {
  webhookId: string;
  webhookToken: string;
  accountId?: string;
  threadId?: string | number;
  replyTo?: string;
  username?: string;
  avatarUrl?: string;
  wait?: boolean;
};

function resolveWebhookExecutionUrl(params: {
  webhookId: string;
  webhookToken: string;
  threadId?: string | number;
  wait?: boolean;
}) {
  const baseUrl = new URL(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(params.webhookId)}/${encodeURIComponent(params.webhookToken)}`,
  );
  baseUrl.searchParams.set("wait", params.wait === false ? "false" : "true");
  if (params.threadId !== undefined && params.threadId !== null && params.threadId !== "") {
    baseUrl.searchParams.set("thread_id", String(params.threadId));
  }
  return baseUrl.toString();
}

export async function sendWebhookMessageDiscord(
  text: string,
  opts: DiscordWebhookSendOpts,
): Promise<DiscordSendResult> {
  const webhookId = opts.webhookId.trim();
  const webhookToken = opts.webhookToken.trim();
  if (!webhookId || !webhookToken) {
    throw new Error("Discord webhook id/token are required");
  }

  const replyTo = typeof opts.replyTo === "string" ? opts.replyTo.trim() : "";
  const messageReference = replyTo ? { message_id: replyTo, fail_if_not_exists: false } : undefined;

  const response = await fetch(
    resolveWebhookExecutionUrl({
      webhookId,
      webhookToken,
      threadId: opts.threadId,
      wait: opts.wait,
    }),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: text,
        username: opts.username?.trim() || undefined,
        avatar_url: opts.avatarUrl?.trim() || undefined,
        ...(messageReference ? { message_reference: messageReference } : {}),
      }),
    },
  );
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(
      `Discord webhook send failed (${response.status}${raw ? `: ${raw.slice(0, 200)}` : ""})`,
    );
  }

  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    channel_id?: string;
  };
  try {
    const account = resolveDiscordAccount({
      cfg: loadConfig(),
      accountId: opts.accountId,
    });
    recordChannelActivity({
      channel: "discord",
      accountId: account.accountId,
      direction: "outbound",
    });
  } catch {
    // Best-effort telemetry only.
  }
  return {
    messageId: payload.id ? String(payload.id) : "unknown",
    channelId: payload.channel_id
      ? String(payload.channel_id)
      : opts.threadId
        ? String(opts.threadId)
        : "",
  };
}

export async function sendStickerDiscord(
  to: string,
  stickerIds: string[],
  opts: DiscordSendOpts & { content?: string } = {},
): Promise<DiscordSendResult> {
  const { rest, request, channelId } = await resolveDiscordSendTarget(to, opts);
  const content = opts.content?.trim();
  const stickers = normalizeStickerIds(stickerIds);
  const res = (await request(
    () =>
      rest.post(Routes.channelMessages(channelId), {
        body: {
          content: content || undefined,
          sticker_ids: stickers,
        },
      }) as Promise<{ id: string; channel_id: string }>,
    "sticker",
  )) as { id: string; channel_id: string };
  return toDiscordSendResult(res, channelId);
}

export async function sendPollDiscord(
  to: string,
  poll: PollInput,
  opts: DiscordSendOpts & { content?: string } = {},
): Promise<DiscordSendResult> {
  const { rest, request, channelId } = await resolveDiscordSendTarget(to, opts);
  const content = opts.content?.trim();
  if (poll.durationSeconds !== undefined) {
    throw new Error("Discord polls do not support durationSeconds; use durationHours");
  }
  const payload = normalizeDiscordPollInput(poll);
  const flags = opts.silent ? SUPPRESS_NOTIFICATIONS_FLAG : undefined;
  const res = (await request(
    () =>
      rest.post(Routes.channelMessages(channelId), {
        body: {
          content: content || undefined,
          poll: payload,
          ...(flags ? { flags } : {}),
        },
      }) as Promise<{ id: string; channel_id: string }>,
    "poll",
  )) as { id: string; channel_id: string };
  return toDiscordSendResult(res, channelId);
}

type VoiceMessageOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  rest?: RequestClient;
  replyTo?: string;
  retry?: RetryConfig;
  silent?: boolean;
};

async function materializeVoiceMessageInput(mediaUrl: string): Promise<{ filePath: string }> {
  // Security: reuse the standard media loader so we apply SSRF guards + allowed-local-root checks.
  // Then write to a private temp file so ffmpeg/ffprobe never sees the original URL/path string.
  const media = await loadWebMediaRaw(mediaUrl, maxBytesForKind("audio"));
  const extFromName = media.fileName ? path.extname(media.fileName) : "";
  const extFromMime = media.contentType ? extensionForMime(media.contentType) : "";
  const ext = extFromName || extFromMime || ".bin";
  const tempDir = resolvePreferredOpenClawTmpDir();
  const filePath = path.join(tempDir, `voice-src-${crypto.randomUUID()}${ext}`);
  await fs.writeFile(filePath, media.buffer, { mode: 0o600 });
  return { filePath };
}

/**
 * Send a voice message to Discord.
 *
 * Voice messages are a special Discord feature that displays audio with a waveform
 * visualization. They require OGG/Opus format and cannot include text content.
 *
 * @param to - Recipient (user ID for DM or channel ID)
 * @param audioPath - Path to local audio file (will be converted to OGG/Opus if needed)
 * @param opts - Send options
 */
export async function sendVoiceMessageDiscord(
  to: string,
  audioPath: string,
  opts: VoiceMessageOpts = {},
): Promise<DiscordSendResult> {
  const { filePath: localInputPath } = await materializeVoiceMessageInput(audioPath);
  let oggPath: string | null = null;
  let oggCleanup = false;
  let token: string | undefined;
  let rest: RequestClient | undefined;
  let channelId: string | undefined;

  try {
    const cfg = loadConfig();
    const accountInfo = resolveDiscordAccount({
      cfg,
      accountId: opts.accountId,
    });
    const client = createDiscordClient(opts, cfg);
    token = client.token;
    rest = client.rest;
    const request = client.request;
    const recipient = await parseAndResolveRecipient(to, opts.accountId);
    channelId = (await resolveChannelId(rest, recipient, request)).channelId;

    // Convert to OGG/Opus if needed
    const ogg = await ensureOggOpus(localInputPath);
    oggPath = ogg.path;
    oggCleanup = ogg.cleanup;

    // Get voice message metadata (duration and waveform)
    const metadata = await getVoiceMessageMetadata(oggPath);

    // Read the audio file
    const audioBuffer = await fs.readFile(oggPath);

    // Send the voice message
    const result = await sendDiscordVoiceMessage(
      rest,
      channelId,
      audioBuffer,
      metadata,
      opts.replyTo,
      request,
      opts.silent,
    );

    recordChannelActivity({
      channel: "discord",
      accountId: accountInfo.accountId,
      direction: "outbound",
    });

    return toDiscordSendResult(result, channelId);
  } catch (err) {
    if (channelId && rest && token) {
      throw await buildDiscordSendError(err, {
        channelId,
        rest,
        token,
        hasMedia: true,
      });
    }
    throw err;
  } finally {
    // Clean up temporary OGG file if we created one
    if (oggCleanup && oggPath) {
      try {
        await fs.unlink(oggPath);
      } catch {
        // Ignore cleanup errors
      }
    }
    try {
      await fs.unlink(localInputPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}
