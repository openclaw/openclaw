import type { RequestClient } from "@buape/carbon";
import type { APIChannel } from "discord-api-types/v10";
import { ChannelType, Routes } from "discord-api-types/v10";
import type { DiscordSendResult } from "./send.types.js";
import { loadConfig } from "../config/config.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { resolveDiscordAccount } from "./accounts.js";
import { registerDiscordComponentEntries } from "./components-registry.js";
import {
  buildDiscordComponentMessage,
  buildDiscordComponentMessageFlags,
  type DiscordComponentMessageSpec,
} from "./components.js";
import {
  buildDiscordSendError,
  createDiscordClient,
  parseAndResolveRecipient,
  resolveChannelId,
  SUPPRESS_NOTIFICATIONS_FLAG,
} from "./send.shared.js";

const DISCORD_FORUM_LIKE_TYPES = new Set<number>([ChannelType.GuildForum, ChannelType.GuildMedia]);

type DiscordComponentSendOpts = {
  accountId?: string;
  token?: string;
  rest?: RequestClient;
  silent?: boolean;
  replyTo?: string;
  sessionKey?: string;
  agentId?: string;
};

export async function sendDiscordComponentMessage(
  to: string,
  spec: DiscordComponentMessageSpec,
  opts: DiscordComponentSendOpts = {},
): Promise<DiscordSendResult> {
  const cfg = loadConfig();
  const accountInfo = resolveDiscordAccount({ cfg, accountId: opts.accountId });
  const { token, rest, request } = createDiscordClient(opts, cfg);
  const recipient = await parseAndResolveRecipient(to, opts.accountId);
  const { channelId } = await resolveChannelId(rest, recipient, request);

  let channelType: number | undefined;
  try {
    const channel = (await rest.get(Routes.channel(channelId))) as APIChannel | undefined;
    channelType = channel?.type;
  } catch {
    channelType = undefined;
  }

  if (channelType && DISCORD_FORUM_LIKE_TYPES.has(channelType)) {
    throw new Error("Discord components are not supported in forum-style channels");
  }

  const buildResult = buildDiscordComponentMessage({
    spec,
    sessionKey: opts.sessionKey,
    agentId: opts.agentId,
    accountId: accountInfo.accountId,
  });
  const flags = buildDiscordComponentMessageFlags(buildResult.components);
  const finalFlags = opts.silent
    ? (flags ?? 0) | SUPPRESS_NOTIFICATIONS_FLAG
    : (flags ?? undefined);
  const messageReference = opts.replyTo
    ? { message_id: opts.replyTo, fail_if_not_exists: false }
    : undefined;

  let result: { id: string; channel_id: string };
  try {
    result = (await request(
      () =>
        rest.post(Routes.channelMessages(channelId), {
          body: {
            components: buildResult.components.map((component) => component.serialize()),
            ...(messageReference ? { message_reference: messageReference } : {}),
            ...(finalFlags ? { flags: finalFlags } : {}),
          },
        }) as Promise<{ id: string; channel_id: string }>,
      "components",
    )) as { id: string; channel_id: string };
  } catch (err) {
    throw await buildDiscordSendError(err, {
      channelId,
      rest,
      token,
      hasMedia: false,
    });
  }

  registerDiscordComponentEntries({
    entries: buildResult.entries,
    modals: buildResult.modals,
    messageId: result.id,
  });

  recordChannelActivity({
    channel: "discord",
    accountId: accountInfo.accountId,
    direction: "outbound",
  });

  return {
    messageId: result.id ?? "unknown",
    channelId: result.channel_id ?? channelId,
  };
}
