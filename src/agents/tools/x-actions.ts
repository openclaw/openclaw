/**
 * X (Twitter) action handlers for the message tool.
 *
 * Supports: x-follow, x-unfollow, x-dm, x-like, x-unlike, x-repost, x-unrepost, x-reply, x-post
 *
 * These handlers delegate to the X service layer for actual API operations.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveXAccount } from "../../x/accounts.js";
import { createXService, DEFAULT_ACCOUNT_ID } from "../../x/index.js";
import { jsonResult, readStringParam } from "./common.js";

const X_ACTIONS = new Set([
  "x-follow",
  "x-unfollow",
  "x-dm",
  "x-like",
  "x-unlike",
  "x-reply",
  "x-repost",
  "x-unrepost",
  "x-post",
]);

/**
 * Check if an action is an X-specific action
 */
export function isXAction(action: string): boolean {
  return X_ACTIONS.has(action);
}

/**
 * Resolve the X actions allowlist for a cross-channel originator (e.g. Feishu).
 * Reads `channels.<channel>.xActionsAllowFrom` from config.
 */
function resolveCrossChannelXActionsAllowFrom(
  cfg: OpenClawConfig,
  channel: string,
): string[] | undefined {
  const channels = cfg.channels as Record<string, Record<string, unknown>> | undefined;
  const channelCfg = channels?.[channel];
  if (!channelCfg || typeof channelCfg !== "object") {
    return undefined;
  }
  const list = channelCfg.xActionsAllowFrom;
  if (!Array.isArray(list)) {
    return undefined;
  }
  return list.map((entry) => String(entry).trim());
}

/** Channels allowed to trigger X actions cross-channel (via xActionsAllowFrom). */
const CROSS_CHANNEL_X_ACTION_SOURCES = new Set(["feishu"]);

/**
 * Check if the sender is allowed to trigger proactive X actions (follow, like, reply, dm).
 *
 * Permission model (two separate allowlists, do not mix):
 * - From X: uses `channels.x.actionsAllowFrom` (X user IDs).
 * - From Feishu: uses `channels.feishu.xActionsAllowFrom` (Feishu user IDs).
 * - From other channels: denied.
 */
function checkXActionsAllowed(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  actionCtx?: XActionContext;
}): void {
  const { cfg, accountId, actionCtx } = params;
  const origChannel = actionCtx?.toolContext?.originatingChannel?.trim().toLowerCase();
  const origSenderId = actionCtx?.toolContext?.originatingSenderId?.trim();

  if (!origChannel || !origSenderId) {
    throw new Error(
      "Permission denied: X actions (follow, like, repost, reply, dm) require an originating channel and sender; not allowed from CLI or unattended context.",
    );
  }

  // --- From X: check channels.x.actionsAllowFrom ---
  if (origChannel === "x") {
    const account = resolveXAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
    const list = account?.actionsAllowFrom;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(
        "Permission denied: X actions allowlist (channels.x.actionsAllowFrom) is not configured; proactive X operations are disabled.",
      );
    }
    if (!list.includes(origSenderId)) {
      throw new Error(
        "Permission denied: your X user is not in the actions allowlist (channels.x.actionsAllowFrom); only listed users can trigger follow/like/repost/reply/dm.",
      );
    }
    return;
  }

  // --- From cross-channel sources (e.g. Feishu): check channels.<channel>.xActionsAllowFrom ---
  if (CROSS_CHANNEL_X_ACTION_SOURCES.has(origChannel)) {
    const list = resolveCrossChannelXActionsAllowFrom(cfg, origChannel);
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(
        `Permission denied: X actions allowlist (channels.${origChannel}.xActionsAllowFrom) is not configured; cross-channel X operations from ${origChannel} are disabled.`,
      );
    }
    if (!list.includes(origSenderId)) {
      throw new Error(
        `Permission denied: your ${origChannel} user is not in the actions allowlist (channels.${origChannel}.xActionsAllowFrom); only listed users can trigger follow/like/repost/reply/dm.`,
      );
    }
    return;
  }

  // --- Other channels: denied ---
  throw new Error(
    `Permission denied: X actions are not supported from ${origChannel}. Supported origins: x, ${[...CROSS_CHANNEL_X_ACTION_SOURCES].join(", ")}.`,
  );
}

/**
 * Handle x-post action (post a new standalone tweet).
 */
async function handlePost(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  accountId?: string,
): Promise<AgentToolResult<unknown>> {
  const message = readStringParam(params, "message", { required: true });
  const xService = createXService(cfg, { accountId: accountId ?? DEFAULT_ACCOUNT_ID });

  const result = await xService.sendTweet(message);

  if (!result.ok) {
    throw new Error(result.error ?? "Failed to post tweet");
  }

  return jsonResult({
    ok: true,
    action: "x-post",
    tweetId: result.tweetId,
  });
}

/**
 * Parse a tweet ID from various formats (for validation/normalization).
 * Moved to service layer but kept here for backward compatibility with any direct imports.
 */
function parseTweetId(input: string): string {
  const trimmed = input.trim();

  // Check if it's a URL
  const urlMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i,
  );
  if (urlMatch) {
    return urlMatch[1];
  }

  // Assume it's a raw ID
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  throw new Error(
    `Invalid tweet ID or URL: "${input}". Expected a tweet ID or URL like https://x.com/user/status/1234567890`,
  );
}

/**
 * Handle x-follow action
 */
async function handleFollow(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  accountId?: string,
): Promise<AgentToolResult<unknown>> {
  const target = readStringParam(params, "target", { required: true });
  const xService = createXService(cfg, { accountId: accountId ?? DEFAULT_ACCOUNT_ID });

  const result = await xService.followUser(target);

  if (!result.ok) {
    throw new Error(result.error ?? "Failed to follow user");
  }

  return jsonResult({
    ok: true,
    action: "x-follow",
    target,
    following: result.following,
  });
}

/**
 * Handle x-unfollow action
 */
async function handleUnfollow(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  accountId?: string,
): Promise<AgentToolResult<unknown>> {
  const target = readStringParam(params, "target", { required: true });
  const xService = createXService(cfg, { accountId: accountId ?? DEFAULT_ACCOUNT_ID });

  const result = await xService.unfollowUser(target);

  if (!result.ok) {
    throw new Error(result.error ?? "Failed to unfollow user");
  }

  return jsonResult({
    ok: true,
    action: "x-unfollow",
    target,
    following: result.following,
  });
}

/**
 * Handle x-dm action
 */
async function handleDm(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  accountId?: string,
): Promise<AgentToolResult<unknown>> {
  const target = readStringParam(params, "target", { required: true });
  const message = readStringParam(params, "message", { required: true });
  const xService = createXService(cfg, { accountId: accountId ?? DEFAULT_ACCOUNT_ID });

  const result = await xService.sendDM(target, message);

  if (!result.ok) {
    throw new Error(result.error ?? "Failed to send direct message");
  }

  return jsonResult({
    ok: true,
    action: "x-dm",
    target,
    dmId: result.dmId,
    conversationId: result.conversationId,
  });
}

/**
 * Handle x-like action
 */
async function handleLike(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  accountId?: string,
): Promise<AgentToolResult<unknown>> {
  const target = readStringParam(params, "target", { required: true });
  const xService = createXService(cfg, { accountId: accountId ?? DEFAULT_ACCOUNT_ID });
  const tweetId = parseTweetId(target);

  const result = await xService.likeTweet(tweetId);

  if (!result.ok) {
    throw new Error(result.error ?? "Failed to like tweet");
  }

  return jsonResult({
    ok: true,
    action: "x-like",
    tweetId,
    liked: result.liked,
  });
}

/**
 * Handle x-unlike action
 */
async function handleUnlike(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  accountId?: string,
): Promise<AgentToolResult<unknown>> {
  const target = readStringParam(params, "target", { required: true });
  const xService = createXService(cfg, { accountId: accountId ?? DEFAULT_ACCOUNT_ID });
  const tweetId = parseTweetId(target);

  const result = await xService.unlikeTweet(tweetId);

  if (!result.ok) {
    throw new Error(result.error ?? "Failed to unlike tweet");
  }

  return jsonResult({
    ok: true,
    action: "x-unlike",
    tweetId,
    liked: result.liked,
  });
}

/**
 * Handle x-repost action (retweet)
 */
async function handleRepost(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  accountId?: string,
): Promise<AgentToolResult<unknown>> {
  const target = readStringParam(params, "target", { required: true });
  const xService = createXService(cfg, { accountId: accountId ?? DEFAULT_ACCOUNT_ID });
  const tweetId = parseTweetId(target);

  const result = await xService.retweetTweet(tweetId);

  if (!result.ok) {
    throw new Error(result.error ?? "Failed to retweet");
  }

  return jsonResult({
    ok: true,
    action: "x-repost",
    tweetId,
    retweeted: result.retweeted,
  });
}

/**
 * Handle x-unrepost action (undo retweet)
 */
async function handleUnrepost(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  accountId?: string,
): Promise<AgentToolResult<unknown>> {
  const target = readStringParam(params, "target", { required: true });
  const xService = createXService(cfg, { accountId: accountId ?? DEFAULT_ACCOUNT_ID });
  const tweetId = parseTweetId(target);

  const result = await xService.unretweetTweet(tweetId);

  if (!result.ok) {
    throw new Error(result.error ?? "Failed to unretweet");
  }

  return jsonResult({
    ok: true,
    action: "x-unrepost",
    tweetId,
    retweeted: result.retweeted,
  });
}

/** Optional context for permission checks (e.g. x-reply only to mentioner when from X). */
export type XActionContext = {
  toolContext?: {
    originatingChannel?: string;
    originatingSenderId?: string;
  };
};

/**
 * Handle x-reply action (comment/reply to a tweet).
 * When the control message originated from X (mention), only allows replying to that user's tweets.
 */
async function handleReply(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  accountId?: string,
  actionCtx?: XActionContext,
): Promise<AgentToolResult<unknown>> {
  const target = readStringParam(params, "target", { required: true });
  const message = readStringParam(params, "message", { required: true });
  const xService = createXService(cfg, { accountId: accountId ?? DEFAULT_ACCOUNT_ID });
  const tweetId = parseTweetId(target);

  // When triggered from X (mention), only allow replying to the user who mentioned us
  const origChannel = actionCtx?.toolContext?.originatingChannel?.trim().toLowerCase();
  const origSenderId = actionCtx?.toolContext?.originatingSenderId?.trim();
  if (origChannel === "x" && origSenderId) {
    const authorId = await xService.getTweetAuthor(tweetId);
    if (authorId === null) {
      throw new Error("Could not resolve tweet; reply not allowed.");
    }
    if (authorId !== origSenderId) {
      throw new Error(
        "Permission denied: when triggered from an X mention, you can only reply to that user's tweets, not to other users.",
      );
    }
  }

  const result = await xService.replyToTweet(tweetId, message);

  if (!result.ok) {
    throw new Error(result.error ?? "Failed to reply to tweet");
  }

  return jsonResult({
    ok: true,
    action: "x-reply",
    tweetId,
    replyTweetId: result.tweetId,
  });
}

/**
 * Handle X actions dispatched from the message tool.
 * Pass full ctx so x-reply can enforce "reply only to mentioner" when originating from X.
 * All proactive X actions (follow, like, reply, dm) require the sender to be in actionsAllowFrom (X).
 */
export async function handleXAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  accountId?: string,
  actionCtx?: XActionContext,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });

  // Proactive X operations: require sender to be in actions allowlist (separate from mention allowlist)
  checkXActionsAllowed({ cfg, accountId, actionCtx });

  switch (action) {
    case "x-follow":
      return handleFollow(params, cfg, accountId);
    case "x-unfollow":
      return handleUnfollow(params, cfg, accountId);
    case "x-dm":
      return handleDm(params, cfg, accountId);
    case "x-like":
      return handleLike(params, cfg, accountId);
    case "x-unlike":
      return handleUnlike(params, cfg, accountId);
    case "x-reply":
      return handleReply(params, cfg, accountId, actionCtx);
    case "x-repost":
      return handleRepost(params, cfg, accountId);
    case "x-unrepost":
      return handleUnrepost(params, cfg, accountId);
    case "x-post":
      return handlePost(params, cfg, accountId);
    default:
      throw new Error(`Unknown X action: ${action}`);
  }
}
