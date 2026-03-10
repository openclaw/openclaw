import type { OpenClawConfig } from "../../../config/config.js";
import { archiveDiscordThread } from "../../../discord/monitor/thread-bindings.discord-api.js";
import {
  getThreadBindingManager,
  type ThreadBindingRecord,
} from "../../../discord/monitor/thread-bindings.js";
import {
  editMessageDiscord,
  sendMessageDiscord,
  sendPollDiscord,
  sendWebhookMessageDiscord,
} from "../../../discord/send.js";
import { logVerbose } from "../../../globals.js";
import type { OutboundIdentity } from "../../../infra/outbound/identity.js";
import { normalizeDiscordOutboundTarget } from "../normalize/discord.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { sendTextMediaPayload } from "./direct-text-media.js";

function resolveDiscordOutboundTarget(params: {
  to: string;
  threadId?: string | number | null;
}): string {
  if (params.threadId == null) {
    return params.to;
  }
  const threadId = String(params.threadId).trim();
  if (!threadId) {
    return params.to;
  }
  return `channel:${threadId}`;
}

function resolveDiscordWebhookIdentity(params: {
  identity?: OutboundIdentity;
  binding: ThreadBindingRecord;
}): { username?: string; avatarUrl?: string } {
  const usernameRaw = params.identity?.name?.trim();
  const fallbackUsername = params.binding.label?.trim() || params.binding.agentId;
  const username = (usernameRaw || fallbackUsername || "").slice(0, 80) || undefined;
  const avatarUrl = params.identity?.avatarUrl?.trim() || undefined;
  return { username, avatarUrl };
}

type DiscordArchiveAfterReplyChannelData = {
  archiveCurrentThreadAfterReply?: boolean;
  archiveFailureText?: string;
};

function resolveArchiveAfterReplyChannelData(
  channelData: Record<string, unknown> | undefined,
): DiscordArchiveAfterReplyChannelData | null {
  const discordData = channelData?.discord;
  if (!discordData || typeof discordData !== "object") {
    return null;
  }
  const archiveData = discordData as {
    archiveCurrentThreadAfterReply?: unknown;
    archiveFailureText?: unknown;
  };
  if (archiveData.archiveCurrentThreadAfterReply !== true) {
    return null;
  }
  return {
    archiveCurrentThreadAfterReply: true,
    archiveFailureText:
      typeof archiveData.archiveFailureText === "string"
        ? archiveData.archiveFailureText.trim() || undefined
        : undefined,
  };
}

async function sendDiscordArchiveAfterReplyPayload(
  ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0],
  archiveAfterReply: DiscordArchiveAfterReplyChannelData,
) {
  const threadId = String(ctx.threadId).trim();
  const target = resolveDiscordOutboundTarget({ to: ctx.to, threadId });
  const accountId = ctx.accountId ?? undefined;
  const text = ctx.payload.text ?? "";

  const send = ctx.deps?.sendDiscord ?? sendMessageDiscord;
  const sent = await send(target, text, {
    cfg: ctx.cfg,
    accountId,
    replyTo: ctx.replyToId ?? undefined,
    silent: ctx.silent ?? undefined,
    verbose: false,
  });
  const delivery = { channel: "discord" as const, ...sent };

  try {
    await archiveDiscordThread({
      cfg: ctx.cfg,
      accountId: accountId ?? "default",
      threadId,
    });
  } catch (error) {
    logVerbose(`discord outbound thread archive failed for ${threadId}: ${String(error)}`);
    const failureText = archiveAfterReply.archiveFailureText?.trim();
    if (failureText && sent.messageId) {
      try {
        await editMessageDiscord(
          threadId,
          sent.messageId,
          { content: failureText },
          {
            cfg: ctx.cfg,
            accountId,
          },
        );
      } catch (editError) {
        logVerbose(
          `discord outbound archive failure message edit failed for ${threadId}:${sent.messageId}: ${String(editError)}`,
        );
      }
    }
  }

  return delivery;
}

async function maybeSendDiscordWebhookText(params: {
  cfg?: OpenClawConfig;
  text: string;
  threadId?: string | number | null;
  accountId?: string | null;
  identity?: OutboundIdentity;
  replyToId?: string | null;
}): Promise<{ messageId: string; channelId: string } | null> {
  if (params.threadId == null) {
    return null;
  }
  const threadId = String(params.threadId).trim();
  if (!threadId) {
    return null;
  }
  const manager = getThreadBindingManager(params.accountId ?? undefined);
  if (!manager) {
    return null;
  }
  const binding = manager.getByThreadId(threadId);
  if (!binding?.webhookId || !binding?.webhookToken) {
    return null;
  }
  const persona = resolveDiscordWebhookIdentity({
    identity: params.identity,
    binding,
  });
  const result = await sendWebhookMessageDiscord(params.text, {
    webhookId: binding.webhookId,
    webhookToken: binding.webhookToken,
    accountId: binding.accountId,
    threadId: binding.threadId,
    cfg: params.cfg,
    replyTo: params.replyToId ?? undefined,
    username: persona.username,
    avatarUrl: persona.avatarUrl,
  });
  return result;
}

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2000,
  pollMaxOptions: 10,
  resolveTarget: ({ to }) => normalizeDiscordOutboundTarget(to),
  sendPayload: async (ctx) => {
    const archiveAfterReply = resolveArchiveAfterReplyChannelData(ctx.payload.channelData);
    const threadId =
      ctx.threadId !== undefined && ctx.threadId !== null ? String(ctx.threadId).trim() : "";
    const hasMedia = Boolean(ctx.payload.mediaUrl) || Boolean(ctx.payload.mediaUrls?.length);
    if (!archiveAfterReply || !threadId || hasMedia) {
      return await sendTextMediaPayload({
        channel: "discord",
        ctx,
        adapter: discordOutbound,
      });
    }
    return await sendDiscordArchiveAfterReplyPayload(ctx, archiveAfterReply);
  },
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, identity, silent }) => {
    if (!silent) {
      const webhookResult = await maybeSendDiscordWebhookText({
        cfg,
        text,
        threadId,
        accountId,
        identity,
        replyToId,
      }).catch(() => null);
      if (webhookResult) {
        return { channel: "discord", ...webhookResult };
      }
    }
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const target = resolveDiscordOutboundTarget({ to, threadId });
    const result = await send(target, text, {
      verbose: false,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
      cfg,
    });
    return { channel: "discord", ...result };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
    silent,
  }) => {
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const target = resolveDiscordOutboundTarget({ to, threadId });
    const result = await send(target, text, {
      verbose: false,
      mediaUrl,
      mediaLocalRoots,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
      cfg,
    });
    return { channel: "discord", ...result };
  },
  sendPoll: async ({ cfg, to, poll, accountId, threadId, silent }) => {
    const target = resolveDiscordOutboundTarget({ to, threadId });
    return await sendPollDiscord(target, poll, {
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
      cfg,
    });
  },
};
