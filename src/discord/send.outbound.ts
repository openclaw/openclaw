import type { RequestClient } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import { loadConfig } from "../config/config.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import type { RetryConfig } from "../infra/retry.js";
import type { PollInput } from "../polls.js";
import { resolveDiscordAccount } from "./accounts.js";
import {
  buildDiscordSendError,
  createDiscordClient,
  normalizeDiscordPollInput,
  normalizeStickerIds,
  parseRecipient,
  resolveChannelId,
  sendDiscordMedia,
  sendDiscordText,
} from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";

type DiscordSendOpts = {
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  verbose?: boolean;
  rest?: RequestClient;
  replyTo?: string;
  retry?: RetryConfig;
  embeds?: unknown[];
};

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
  const { token, rest, request } = createDiscordClient(opts, cfg);
  const recipient = parseRecipient(to);
  const { channelId } = await resolveChannelId(rest, recipient, request);
  let result: { id: string; channel_id: string } | { id: string | null; channel_id: string };
  try {
    if (opts.mediaUrl) {
      result = await sendDiscordMedia(
        rest,
        channelId,
        text,
        opts.mediaUrl,
        opts.replyTo,
        request,
        accountInfo.config.maxLinesPerMessage,
        opts.embeds,
      );
    } else {
      result = await sendDiscordText(
        rest,
        channelId,
        text,
        opts.replyTo,
        request,
        accountInfo.config.maxLinesPerMessage,
        opts.embeds,
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
  return {
    messageId: result.id ? String(result.id) : "unknown",
    channelId: String(result.channel_id ?? channelId),
  };
}

export async function sendStickerDiscord(
  to: string,
  stickerIds: string[],
  opts: DiscordSendOpts & { content?: string } = {},
): Promise<DiscordSendResult> {
  const cfg = loadConfig();
  const { rest, request } = createDiscordClient(opts, cfg);
  const recipient = parseRecipient(to);
  const { channelId } = await resolveChannelId(rest, recipient, request);
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
  return {
    messageId: res.id ? String(res.id) : "unknown",
    channelId: String(res.channel_id ?? channelId),
  };
}

export async function sendPollDiscord(
  to: string,
  poll: PollInput,
  opts: DiscordSendOpts & { content?: string } = {},
): Promise<DiscordSendResult> {
  const cfg = loadConfig();
  const { rest, request } = createDiscordClient(opts, cfg);
  const recipient = parseRecipient(to);
  const { channelId } = await resolveChannelId(rest, recipient, request);
  const content = opts.content?.trim();
  const payload = normalizeDiscordPollInput(poll);
  const res = (await request(
    () =>
      rest.post(Routes.channelMessages(channelId), {
        body: {
          content: content || undefined,
          poll: payload,
        },
      }) as Promise<{ id: string; channel_id: string }>,
    "poll",
  )) as { id: string; channel_id: string };
  return {
    messageId: res.id ? String(res.id) : "unknown",
    channelId: String(res.channel_id ?? channelId),
  };
}
