import { parseSlackBlocksInput } from "../../../../extensions/slack/src/blocks-input.js";
import { sendMessageSlack, type SlackSendIdentity } from "../../../../extensions/slack/src/send.js";
import type { OutboundIdentity } from "../../../infra/outbound/identity.js";
import { resolveOutboundSendDep } from "../../../infra/outbound/send-deps.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { sendTextMediaPayload } from "./direct-text-media.js";

function resolveSlackSendIdentity(identity?: OutboundIdentity): SlackSendIdentity | undefined {
  if (!identity) {
    return undefined;
  }
  const username = identity.name?.trim() || undefined;
  const iconUrl = identity.avatarUrl?.trim() || undefined;
  const rawEmoji = identity.emoji?.trim();
  const iconEmoji = !iconUrl && rawEmoji && /^:[^:\s]+:$/.test(rawEmoji) ? rawEmoji : undefined;
  if (!username && !iconUrl && !iconEmoji) {
    return undefined;
  }
  return { username, iconUrl, iconEmoji };
}

async function applySlackMessageSendingHooks(params: {
  to: string;
  text: string;
  threadTs?: string;
  accountId?: string;
  mediaUrl?: string;
}): Promise<{ cancelled: boolean; text: string }> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("message_sending")) {
    return { cancelled: false, text: params.text };
  }
  const hookResult = await hookRunner.runMessageSending(
    {
      to: params.to,
      content: params.text,
      metadata: {
        threadTs: params.threadTs,
        channelId: params.to,
        ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
      },
    },
    { channelId: "slack", accountId: params.accountId ?? undefined },
  );
  if (hookResult?.cancel) {
    return { cancelled: true, text: params.text };
  }
  return { cancelled: false, text: hookResult?.content ?? params.text };
}

async function sendSlackOutboundMessage(params: {
  cfg: NonNullable<Parameters<typeof sendMessageSlack>[2]>["cfg"];
  to: string;
  text: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  blocks?: NonNullable<Parameters<typeof sendMessageSlack>[2]>["blocks"];
  accountId?: string | null;
  deps?: { [channelId: string]: unknown } | null;
  replyToId?: string | null;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
}) {
  const send =
    resolveOutboundSendDep<typeof sendMessageSlack>(params.deps, "slack") ?? sendMessageSlack;
  // Use threadId fallback so routed tool notifications stay in the Slack thread.
  const threadTs =
    params.replyToId ?? (params.threadId != null ? String(params.threadId) : undefined);
  const hookResult = await applySlackMessageSendingHooks({
    to: params.to,
    text: params.text,
    threadTs,
    mediaUrl: params.mediaUrl,
    accountId: params.accountId ?? undefined,
  });
  if (hookResult.cancelled) {
    return {
      channel: "slack" as const,
      messageId: "cancelled-by-hook",
      channelId: params.to,
      meta: { cancelled: true },
    };
  }

  const slackIdentity = resolveSlackSendIdentity(params.identity);
  const result = await send(params.to, hookResult.text, {
    cfg: params.cfg,
    threadTs,
    accountId: params.accountId ?? undefined,
    ...(params.mediaUrl
      ? { mediaUrl: params.mediaUrl, mediaLocalRoots: params.mediaLocalRoots }
      : {}),
    ...(params.blocks ? { blocks: params.blocks } : {}),
    ...(slackIdentity ? { identity: slackIdentity } : {}),
  });
  return { channel: "slack" as const, ...result };
}

function resolveSlackBlocks(channelData: Record<string, unknown> | undefined) {
  const slackData = channelData?.slack;
  if (!slackData || typeof slackData !== "object" || Array.isArray(slackData)) {
    return undefined;
  }
  return parseSlackBlocksInput((slackData as { blocks?: unknown }).blocks);
}

export const slackOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 4000,
  sendPayload: async (ctx) => {
    const blocks = resolveSlackBlocks(ctx.payload.channelData);
    if (!blocks) {
      return await sendTextMediaPayload({ channel: "slack", ctx, adapter: slackOutbound });
    }
    return await sendSlackOutboundMessage({
      cfg: ctx.cfg,
      to: ctx.to,
      text: ctx.payload.text ?? "",
      mediaUrl: ctx.payload.mediaUrl,
      mediaLocalRoots: ctx.mediaLocalRoots,
      blocks,
      accountId: ctx.accountId,
      deps: ctx.deps,
      replyToId: ctx.replyToId,
      threadId: ctx.threadId,
      identity: ctx.identity,
    });
  },
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, identity }) => {
    return await sendSlackOutboundMessage({
      cfg,
      to,
      text,
      accountId,
      deps,
      replyToId,
      threadId,
      identity,
    });
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
    identity,
  }) => {
    return await sendSlackOutboundMessage({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      accountId,
      deps,
      replyToId,
      threadId,
      identity,
    });
  },
};
