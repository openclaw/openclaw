/**
 * X (Twitter) API v2 client wrapper.
 *
 * Handles authentication and API interactions using OAuth 1.0a credentials.
 */

import { HttpsProxyAgent } from "https-proxy-agent";
import { TwitterApi } from "twitter-api-v2";
import type {
  XAccountConfig,
  XMention,
  XSendResult,
  XLogSink,
  XFollowResult,
  XDmResult,
  XLikeResult,
  XUserInfo,
} from "./types.js";

/**
 * Manages X API client connections
 */
export class XClientManager {
  private clients = new Map<string, TwitterApi>();
  private proxyUrl?: string;

  constructor(
    private logger: XLogSink,
    options?: { proxyUrl?: string },
  ) {
    this.proxyUrl = options?.proxyUrl;
  }

  /**
   * Get or create an authenticated client for an account
   */
  getClient(account: XAccountConfig, accountId: string): TwitterApi {
    const existing = this.clients.get(accountId);
    if (existing) {
      return existing;
    }

    if (!account.consumerKey || !account.consumerSecret) {
      throw new Error("Missing X consumer key/secret");
    }
    if (!account.accessToken || !account.accessTokenSecret) {
      throw new Error("Missing X access token/secret");
    }

    // Configure proxy agent if proxy URL is set
    const httpAgent = this.proxyUrl ? new HttpsProxyAgent(this.proxyUrl) : undefined;

    const client = new TwitterApi(
      {
        appKey: account.consumerKey,
        appSecret: account.consumerSecret,
        accessToken: account.accessToken,
        accessSecret: account.accessTokenSecret,
      },
      httpAgent ? { httpAgent } : undefined,
    );

    this.clients.set(accountId, client);
    this.logger.info(
      `Created X client for account ${accountId}${this.proxyUrl ? ` (proxy: ${this.proxyUrl})` : ""}`,
    );

    return client;
  }

  /**
   * Get the authenticated user's info
   */
  async getMe(
    account: XAccountConfig,
    accountId: string,
  ): Promise<{
    id: string;
    username: string;
    name: string;
  }> {
    const client = this.getClient(account, accountId);
    try {
      const me = await client.v2.me({
        "user.fields": ["id", "username", "name"],
      });
      return {
        id: me.data.id,
        username: me.data.username,
        name: me.data.name,
      };
    } catch (error: unknown) {
      // Log detailed error info for debugging
      const apiError = error as {
        code?: number;
        data?: { detail?: string; title?: string; errors?: Array<{ message?: string }> };
        rateLimitError?: boolean;
        rateLimit?: { limit?: number; remaining?: number; reset?: number };
      };
      if (apiError.data) {
        this.logger.error(
          `X API error - code: ${apiError.code}, detail: ${JSON.stringify(apiError.data)}`,
        );
      }
      if (apiError.rateLimitError) {
        this.logger.error(
          `X API rate limit hit - limit: ${apiError.rateLimit?.limit}, remaining: ${apiError.rateLimit?.remaining}`,
        );
      }
      throw error;
    }
  }

  /**
   * Fetch mentions for the authenticated user
   *
   * @param sinceId - Only return tweets newer than this ID (for incremental polling)
   */
  async getMentions(
    account: XAccountConfig,
    accountId: string,
    sinceId?: string,
  ): Promise<{ mentions: XMention[]; newestId?: string }> {
    const client = this.getClient(account, accountId);

    // First get the authenticated user's ID
    const me = await this.getMe(account, accountId);

    const options: Parameters<typeof client.v2.userMentionTimeline>[1] = {
      max_results: 100,
      "tweet.fields": [
        "id",
        "text",
        "author_id",
        "created_at",
        "conversation_id",
        "in_reply_to_user_id",
      ],
      "user.fields": ["id", "username", "name"],
      expansions: ["author_id"],
    };

    if (sinceId) {
      options.since_id = sinceId;
    }

    const response = await client.v2.userMentionTimeline(me.id, options);

    const mentions: XMention[] = [];
    const users = new Map<string, { username: string; name: string }>();

    // Build user lookup from includes
    if (response.includes?.users) {
      for (const user of response.includes.users) {
        users.set(user.id, { username: user.username, name: user.name });
      }
    }

    // Process tweets
    for (const tweet of response.data?.data ?? []) {
      const author = users.get(tweet.author_id ?? "");
      mentions.push({
        id: tweet.id,
        text: tweet.text,
        authorId: tweet.author_id ?? "",
        authorUsername: author?.username,
        authorName: author?.name,
        createdAt: tweet.created_at ? new Date(tweet.created_at) : undefined,
        conversationId: tweet.conversation_id,
      });
    }

    // Get the newest ID for next poll
    const newestId = response.data?.meta?.newest_id;

    return { mentions, newestId };
  }

  /**
   * Reply to a tweet
   */
  async replyToTweet(
    account: XAccountConfig,
    accountId: string,
    replyToTweetId: string,
    text: string,
  ): Promise<XSendResult> {
    try {
      const client = this.getClient(account, accountId);

      const result = await client.v2.tweet({
        text,
        reply: {
          in_reply_to_tweet_id: replyToTweetId,
        },
      });

      this.logger.info(`Sent reply to tweet ${replyToTweetId}: ${result.data.id}`);

      return {
        ok: true,
        tweetId: result.data.id,
      };
    } catch (error: unknown) {
      let errorMsg = error instanceof Error ? error.message : String(error);

      // Extract more details from twitter-api-v2 errors
      const apiError = error as {
        code?: number;
        data?: { detail?: string; title?: string; errors?: Array<{ message?: string }> };
      };
      if (apiError.data) {
        const detail = apiError.data.detail || apiError.data.title || "";
        const errors = apiError.data.errors?.map((e) => e.message).join(", ") || "";
        if (detail || errors) {
          errorMsg = `${errorMsg} - ${detail} ${errors}`.trim();
        }
        this.logger.error(`X API error details: ${JSON.stringify(apiError.data)}`);
      }

      this.logger.error(`Failed to reply to tweet ${replyToTweetId}: ${errorMsg}`);
      return {
        ok: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Send a standalone tweet (not a reply)
   */
  async sendTweet(account: XAccountConfig, accountId: string, text: string): Promise<XSendResult> {
    try {
      const client = this.getClient(account, accountId);

      const result = await client.v2.tweet({ text });

      this.logger.info(`Sent tweet: ${result.data.id}`);

      return {
        ok: true,
        tweetId: result.data.id,
      };
    } catch (error: unknown) {
      let errorMsg = error instanceof Error ? error.message : String(error);

      // Extract more details from twitter-api-v2 errors
      const apiError = error as {
        code?: number;
        data?: { detail?: string; title?: string; errors?: Array<{ message?: string }> };
      };
      if (apiError.data) {
        const detail = apiError.data.detail || apiError.data.title || "";
        const errors = apiError.data.errors?.map((e) => e.message).join(", ") || "";
        if (detail || errors) {
          errorMsg = `${errorMsg} - ${detail} ${errors}`.trim();
        }
        this.logger.error(`X API error details: ${JSON.stringify(apiError.data)}`);
      }

      this.logger.error(`Failed to send tweet: ${errorMsg}`);
      return {
        ok: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Get a single tweet by ID (for permission checks: reply only to same author when triggered from X).
   * Returns the tweet author ID or null if not found.
   */
  async getTweetAuthor(
    account: XAccountConfig,
    accountId: string,
    tweetId: string,
  ): Promise<string | null> {
    try {
      const client = this.getClient(account, accountId);
      const result = await client.v2.singleTweet(tweetId, {
        "tweet.fields": ["author_id"],
      });
      const authorId = result.data?.author_id ?? null;
      return authorId;
    } catch (error: unknown) {
      this.logger.debug?.(
        `Failed to get tweet ${tweetId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Look up a user by username (handle).
   * Strips leading @ if present.
   */
  async getUserByUsername(
    account: XAccountConfig,
    accountId: string,
    username: string,
  ): Promise<XUserInfo | null> {
    try {
      const client = this.getClient(account, accountId);
      // Strip @ prefix if present
      const cleanUsername = username.replace(/^@/, "");
      const result = await client.v2.userByUsername(cleanUsername, {
        "user.fields": ["id", "username", "name"],
      });

      if (!result.data) {
        return null;
      }

      return {
        id: result.data.id,
        username: result.data.username,
        name: result.data.name,
      };
    } catch (error: unknown) {
      this.logger.error(
        `Failed to look up user @${username}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Follow a user by their ID
   */
  async followUser(
    account: XAccountConfig,
    accountId: string,
    targetUserId: string,
  ): Promise<XFollowResult> {
    try {
      const client = this.getClient(account, accountId);
      const me = await this.getMe(account, accountId);

      const result = await client.v2.follow(me.id, targetUserId);

      this.logger.info(`Followed user ${targetUserId}`);

      return {
        ok: true,
        following: result.data.following,
      };
    } catch (error: unknown) {
      const errorMsg = this.extractApiError(error);
      this.logger.error(`Failed to follow user ${targetUserId}: ${errorMsg}`);
      return {
        ok: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Unfollow a user by their ID
   */
  async unfollowUser(
    account: XAccountConfig,
    accountId: string,
    targetUserId: string,
  ): Promise<XFollowResult> {
    try {
      const client = this.getClient(account, accountId);
      const me = await this.getMe(account, accountId);

      const result = await client.v2.unfollow(me.id, targetUserId);

      this.logger.info(`Unfollowed user ${targetUserId}`);

      return {
        ok: true,
        following: result.data.following,
      };
    } catch (error: unknown) {
      const errorMsg = this.extractApiError(error);
      this.logger.error(`Failed to unfollow user ${targetUserId}: ${errorMsg}`);
      return {
        ok: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Send a direct message to a user
   */
  async sendDirectMessage(
    account: XAccountConfig,
    accountId: string,
    recipientId: string,
    text: string,
  ): Promise<XDmResult> {
    try {
      const client = this.getClient(account, accountId);

      const result = await client.v2.sendDmToParticipant(recipientId, { text });

      this.logger.info(`Sent DM to user ${recipientId}: ${result.dm_event_id}`);

      return {
        ok: true,
        dmId: result.dm_event_id,
        conversationId: result.dm_conversation_id,
      };
    } catch (error: unknown) {
      const errorMsg = this.extractApiError(error);
      this.logger.error(`Failed to send DM to user ${recipientId}: ${errorMsg}`);
      return {
        ok: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Like a tweet
   */
  async likeTweet(
    account: XAccountConfig,
    accountId: string,
    tweetId: string,
  ): Promise<XLikeResult> {
    try {
      const client = this.getClient(account, accountId);
      const me = await this.getMe(account, accountId);

      const result = await client.v2.like(me.id, tweetId);

      this.logger.info(`Liked tweet ${tweetId}`);

      return {
        ok: true,
        liked: result.data.liked,
      };
    } catch (error: unknown) {
      const errorMsg = this.extractApiError(error);
      this.logger.error(`Failed to like tweet ${tweetId}: ${errorMsg}`);
      return {
        ok: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Unlike a tweet
   */
  async unlikeTweet(
    account: XAccountConfig,
    accountId: string,
    tweetId: string,
  ): Promise<XLikeResult> {
    try {
      const client = this.getClient(account, accountId);
      const me = await this.getMe(account, accountId);

      const result = await client.v2.unlike(me.id, tweetId);

      this.logger.info(`Unliked tweet ${tweetId}`);

      return {
        ok: true,
        liked: result.data.liked,
      };
    } catch (error: unknown) {
      const errorMsg = this.extractApiError(error);
      this.logger.error(`Failed to unlike tweet ${tweetId}: ${errorMsg}`);
      return {
        ok: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Extract error message from twitter-api-v2 errors
   */
  private extractApiError(error: unknown): string {
    let errorMsg = error instanceof Error ? error.message : String(error);

    const apiError = error as {
      code?: number;
      data?: { detail?: string; title?: string; errors?: Array<{ message?: string }> };
    };
    if (apiError.data) {
      const detail = apiError.data.detail || apiError.data.title || "";
      const errors = apiError.data.errors?.map((e) => e.message).join(", ") || "";
      if (detail || errors) {
        errorMsg = `${errorMsg} - ${detail} ${errors}`.trim();
      }
      this.logger.error(`X API error details: ${JSON.stringify(apiError.data)}`);
    }

    return errorMsg;
  }

  /**
   * Remove a client from the cache
   */
  removeClient(accountId: string): void {
    this.clients.delete(accountId);
    this.logger.info(`Removed X client for account ${accountId}`);
  }

  /**
   * Clear all clients
   */
  clearAll(): void {
    this.clients.clear();
    this.logger.info("Cleared all X clients");
  }
}

// Global client manager registry (one per account)
const clientManagers = new Map<string, XClientManager>();

export type XClientManagerOptions = {
  proxyUrl?: string;
};

export function getOrCreateClientManager(
  accountId: string,
  logger: XLogSink,
  options?: XClientManagerOptions,
): XClientManager {
  const cacheKey = options?.proxyUrl ? `${accountId}:${options.proxyUrl}` : accountId;
  let manager = clientManagers.get(cacheKey);
  if (!manager) {
    manager = new XClientManager(logger, { proxyUrl: options?.proxyUrl });
    clientManagers.set(cacheKey, manager);
  }
  return manager;
}

export function removeClientManager(accountId: string): void {
  const manager = clientManagers.get(accountId);
  if (manager) {
    manager.clearAll();
    clientManagers.delete(accountId);
  }
}
