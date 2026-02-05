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
  XTweet,
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
    const endpoint = `/2/users/me`;
    const method = "GET";

    try {
      this.logger.info(`[X API] ${method} ${endpoint}`);

      const me = await client.v2.me({
        "user.fields": ["id", "username", "name"],
      });

      this.logger.info(`[X API] ${method} ${endpoint} - Success (user: ${me.data.id})`);
      this.logRateLimitFromClient(client, "users/me", `${method} ${endpoint}`);

      return {
        id: me.data.id,
        username: me.data.username,
        name: me.data.name,
      };
    } catch (error: unknown) {
      const apiError = error as {
        code?: number;
        data?: { detail?: string; title?: string; errors?: Array<{ message?: string }> };
        rateLimitError?: boolean;
        rateLimit?: { limit?: number; remaining?: number; reset?: number };
        headers?: Record<string, string | string[] | undefined>;
      };
      this.logRateLimitFromResponse(`${method} ${endpoint}`, apiError.rateLimit, apiError.headers);
      this.logApiCall(endpoint, method, undefined, undefined, error);

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
    const endpoint = `/2/users/:id/mentions`;
    const method = "GET";

    try {
      const client = this.getClient(account, accountId);

      // Get authenticated user's ID (consumes users/me rate limit once per getMentions call, e.g. every poll)
      const me = await this.getMe(account, accountId);

      this.logger.info(
        `[X API] ${method} ${endpoint} - user: ${me.id}${sinceId ? `, since: ${sinceId}` : ""}`,
      );

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

      this.logger.info(
        `[X API] ${method} ${endpoint} - Success (${mentions.length} mentions, newest: ${newestId})`,
      );
      // twitter-api-v2 stores this endpoint's rate limit under "users/:id/mentions" (literal :id)
      this.logRateLimitFromClient(client, "users/:id/mentions", `${method} ${endpoint}`);

      return { mentions, newestId };
    } catch (error: unknown) {
      const apiError = error as {
        rateLimit?: { limit?: number; remaining?: number; reset?: number };
        headers?: Record<string, string | string[] | undefined>;
      };
      this.logRateLimitFromResponse(`${method} ${endpoint}`, apiError.rateLimit, apiError.headers);
      this.logApiCall(endpoint, method, undefined, undefined, error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[X API] ${method} ${endpoint} - Failed: ${errorMsg}`);
      throw error;
    }
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
    const endpoint = `/2/tweets`;
    const method = "POST";

    try {
      const client = this.getClient(account, accountId);

      this.logger.info(
        `[X API] ${method} ${endpoint} - reply to: ${replyToTweetId}, text length: ${text.length}`,
      );

      const result = await client.v2.tweet({
        text,
        reply: {
          in_reply_to_tweet_id: replyToTweetId,
        },
      });

      this.logger.info(`[X API] ${method} ${endpoint} - Success (reply tweet: ${result.data.id})`);
      this.logger.info(`Sent reply to tweet ${replyToTweetId}: ${result.data.id}`);
      this.logRateLimitFromClient(client, "tweets", `${method} ${endpoint}`);

      return {
        ok: true,
        tweetId: result.data.id,
      };
    } catch (error: unknown) {
      const apiError = error as {
        code?: number;
        data?: { detail?: string; title?: string; errors?: Array<{ message?: string }> };
        rateLimit?: { limit?: number; remaining?: number; reset?: number };
        headers?: Record<string, string | string[] | undefined>;
      };
      this.logRateLimitFromResponse(`${method} ${endpoint}`, apiError.rateLimit, apiError.headers);
      this.logApiCall(endpoint, method, undefined, undefined, error);
      let errorMsg = error instanceof Error ? error.message : String(error);
      if (apiError.code) {
        errorMsg = `HTTP ${apiError.code} - ${errorMsg}`;
      }
      if (apiError.data) {
        const detail = apiError.data.detail || apiError.data.title || "";
        const errors =
          apiError.data.errors?.map((e: { message?: string }) => e.message).join(", ") || "";
        if (detail || errors) {
          errorMsg = `${errorMsg} - ${detail} ${errors}`.trim();
        }
        this.logger.error(`X API error details: ${JSON.stringify(apiError.data)}`);
      }

      this.logger.error(`[X API] ${method} ${endpoint} - Failed: ${errorMsg}`);
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
    const endpoint = `/2/tweets`;
    const method = "POST";

    try {
      const client = this.getClient(account, accountId);

      this.logger.info(`[X API] ${method} ${endpoint} - text length: ${text.length}`);

      const result = await client.v2.tweet({ text });

      this.logger.info(`[X API] ${method} ${endpoint} - Success (tweet: ${result.data.id})`);
      this.logger.info(`Sent tweet: ${result.data.id}`);
      this.logRateLimitFromClient(client, "tweets", `${method} ${endpoint}`);

      return {
        ok: true,
        tweetId: result.data.id,
      };
    } catch (error: unknown) {
      const apiError = error as {
        code?: number;
        data?: { detail?: string; title?: string; errors?: Array<{ message?: string }> };
        rateLimit?: { limit?: number; remaining?: number; reset?: number };
        headers?: Record<string, string | string[] | undefined>;
      };
      this.logRateLimitFromResponse(`${method} ${endpoint}`, apiError.rateLimit, apiError.headers);
      this.logApiCall(endpoint, method, undefined, undefined, error);
      let errorMsg = error instanceof Error ? error.message : String(error);
      if (apiError.code) {
        errorMsg = `HTTP ${apiError.code} - ${errorMsg}`;
      }
      if (apiError.data) {
        const detail = apiError.data.detail || apiError.data.title || "";
        const errors = apiError.data.errors?.map((e) => e.message).join(", ") || "";
        if (detail || errors) {
          errorMsg = `${errorMsg} - ${detail} ${errors}`.trim();
        }
        this.logger.error(`X API error details: ${JSON.stringify(apiError.data)}`);
      }

      this.logger.error(`[X API] ${method} ${endpoint} - Failed: ${errorMsg}`);
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
    const endpoint = `/2/tweets/:id`;
    const method = "GET";

    try {
      const client = this.getClient(account, accountId);

      this.logger.debug?.(`[X API] ${method} ${endpoint} - tweet: ${tweetId}`);

      const result = await client.v2.singleTweet(tweetId, {
        "tweet.fields": ["author_id"],
      });

      const authorId = result.data?.author_id ?? null;

      this.logger.debug?.(`[X API] ${method} ${endpoint} - Success (author: ${authorId})`);
      this.logRateLimitFromClient(client, `tweets/${tweetId}`, `${method} ${endpoint}`);

      return authorId;
    } catch (error: unknown) {
      const apiError = error as {
        rateLimit?: { limit?: number; remaining?: number; reset?: number };
        headers?: Record<string, string | string[] | undefined>;
      };
      this.logRateLimitFromResponse(`${method} ${endpoint}`, apiError.rateLimit, apiError.headers);
      this.logApiCall(endpoint, method, undefined, undefined, error);
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
    // Strip @ prefix if present
    const cleanUsername = username.replace(/^@/, "");
    const endpoint = `/2/users/by/username/:username`;
    const method = "GET";

    try {
      const client = this.getClient(account, accountId);

      this.logger.info(`[X API] ${method} ${endpoint} - username: ${cleanUsername}`);

      const result = await client.v2.userByUsername(cleanUsername, {
        "user.fields": ["id", "username", "name"],
      });

      if (!result.data) {
        this.logger.info(`[X API] ${method} ${endpoint} - User not found: ${cleanUsername}`);
        this.logRateLimitFromClient(
          client,
          `users/by/username/${cleanUsername}`,
          `${method} ${endpoint}`,
        );
        return null;
      }

      this.logger.info(`[X API] ${method} ${endpoint} - Success (user: ${result.data.id})`);
      this.logRateLimitFromClient(
        client,
        `users/by/username/${cleanUsername}`,
        `${method} ${endpoint}`,
      );

      return {
        id: result.data.id,
        username: result.data.username,
        name: result.data.name,
      };
    } catch (error: unknown) {
      const apiError = error as {
        rateLimit?: { limit?: number; remaining?: number; reset?: number };
        headers?: Record<string, string | string[] | undefined>;
      };
      this.logRateLimitFromResponse(`${method} ${endpoint}`, apiError.rateLimit, apiError.headers);
      this.logApiCall(endpoint, method, undefined, undefined, error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[X API] ${method} ${endpoint} - Failed: ${errorMsg}`);
      this.logger.error(`Failed to look up user @${username}: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Get user tweets/timeline by user ID
   */
  async getUserTweets(
    account: XAccountConfig,
    accountId: string,
    userId: string,
    maxResults: number = 5,
  ): Promise<XTweet[]> {
    const endpoint = `/2/users/:id/tweets`;
    const method = "GET";

    try {
      const client = this.getClient(account, accountId);

      this.logger.info(`[X API] ${method} ${endpoint} - user: ${userId}, max: ${maxResults}`);

      const response = await client.v2.userTimeline(userId, {
        max_results: maxResults,
        "tweet.fields": ["id", "text", "author_id", "created_at", "conversation_id"],
      });

      const tweets: XTweet[] = [];
      for (const tweet of response.data?.data ?? []) {
        tweets.push({
          id: tweet.id,
          text: tweet.text,
          authorId: tweet.author_id,
          createdAt: tweet.created_at ? new Date(tweet.created_at) : undefined,
          conversationId: tweet.conversation_id,
        });
      }

      this.logger.info(`[X API] ${method} ${endpoint} - Success (${tweets.length} tweets)`);
      this.logRateLimitFromClient(client, `users/${userId}/tweets`, `${method} ${endpoint}`);

      return tweets;
    } catch (error: unknown) {
      const apiError = error as {
        rateLimit?: { limit?: number; remaining?: number; reset?: number };
        headers?: Record<string, string | string[] | undefined>;
      };
      this.logRateLimitFromResponse(`${method} ${endpoint}`, apiError.rateLimit, apiError.headers);
      this.logApiCall(endpoint, method, undefined, undefined, error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[X API] ${method} ${endpoint} - Failed: ${errorMsg}`);
      this.logger.error(`Failed to get tweets for user ${userId}: ${errorMsg}`);
      return [];
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
    const endpoint = `/2/users/:id/following`;
    const method = "POST";

    try {
      const client = this.getClient(account, accountId);
      const me = await this.getMe(account, accountId);

      this.logger.info(`[X API] ${method} ${endpoint} - target: ${targetUserId}, me: ${me.id}`);

      const result = await client.v2.follow(me.id, targetUserId);

      this.logger.info(`[X API] ${method} ${endpoint} - Success (target: ${targetUserId})`);
      this.logger.info(`Followed user ${targetUserId}`);
      this.logRateLimitFromClient(client, `users/${me.id}/following`, `${method} ${endpoint}`);

      return {
        ok: true,
        following: result.data.following,
      };
    } catch (error: unknown) {
      const apiError = error as {
        rateLimit?: { limit?: number; remaining?: number; reset?: number };
        headers?: Record<string, string | string[] | undefined>;
      };
      this.logRateLimitFromResponse(`${method} ${endpoint}`, apiError.rateLimit, apiError.headers);
      this.logApiCall(endpoint, method, undefined, undefined, error);
      const errorMsg = this.extractApiError(error);
      this.logger.error(`[X API] ${method} ${endpoint} - Failed: ${errorMsg}`);
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
    const endpoint = `/2/users/:id/following/:target`;
    const method = "DELETE";

    try {
      const client = this.getClient(account, accountId);
      const me = await this.getMe(account, accountId);

      this.logger.info(`[X API] ${method} ${endpoint} - target: ${targetUserId}, me: ${me.id}`);

      const result = await client.v2.unfollow(me.id, targetUserId);

      this.logger.info(`[X API] ${method} ${endpoint} - Success (target: ${targetUserId})`);
      this.logger.info(`Unfollowed user ${targetUserId}`);
      this.logRateLimitFromClient(client, `users/${me.id}/following`, `${method} ${endpoint}`);

      return {
        ok: true,
        following: result.data.following,
      };
    } catch (error: unknown) {
      const apiError = error as {
        rateLimit?: { limit?: number; remaining?: number; reset?: number };
        headers?: Record<string, string | string[] | undefined>;
      };
      this.logRateLimitFromResponse(`${method} ${endpoint}`, apiError.rateLimit, apiError.headers);
      this.logApiCall(endpoint, method, undefined, undefined, error);
      const errorMsg = this.extractApiError(error);
      this.logger.error(`[X API] ${method} ${endpoint} - Failed: ${errorMsg}`);
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
    const endpoint = `/2/dm_conversations/with/:participant_id/messages`;
    const method = "POST";

    try {
      const client = this.getClient(account, accountId);

      this.logger.info(`[X API] ${method} ${endpoint} - recipient: ${recipientId}`);

      const result = await client.v2.sendDmToParticipant(recipientId, { text });

      this.logger.info(`[X API] ${method} ${endpoint} - Success (dm: ${result.dm_event_id})`);
      this.logger.info(`Sent DM to user ${recipientId}: ${result.dm_event_id}`);
      this.logRateLimitFromClient(
        client,
        `dm_conversations/with/${recipientId}/messages`,
        `${method} ${endpoint}`,
      );

      return {
        ok: true,
        dmId: result.dm_event_id,
        conversationId: result.dm_conversation_id,
      };
    } catch (error: unknown) {
      const apiError = error as {
        rateLimit?: { limit?: number; remaining?: number; reset?: number };
        headers?: Record<string, string | string[] | undefined>;
      };
      this.logRateLimitFromResponse(`${method} ${endpoint}`, apiError.rateLimit, apiError.headers);
      this.logApiCall(endpoint, method, undefined, undefined, error);
      const errorMsg = this.extractApiError(error);
      this.logger.error(`[X API] ${method} ${endpoint} - Failed: ${errorMsg}`);
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
    const endpoint = `/2/users/:id/likes`;
    const method = "POST";

    try {
      const client = this.getClient(account, accountId);
      const me = await this.getMe(account, accountId);

      this.logger.info(`[X API] ${method} ${endpoint} - tweet: ${tweetId}, me: ${me.id}`);

      const result = await client.v2.like(me.id, tweetId);

      this.logger.info(`[X API] ${method} ${endpoint} - Success (tweet: ${tweetId})`);
      this.logger.info(`Liked tweet ${tweetId}`);
      this.logRateLimitFromClient(client, `users/${me.id}/likes`, `${method} ${endpoint}`);

      return {
        ok: true,
        liked: result.data.liked,
      };
    } catch (error: unknown) {
      const apiError = error as {
        rateLimit?: { limit?: number; remaining?: number; reset?: number };
        headers?: Record<string, string | string[] | undefined>;
      };
      this.logRateLimitFromResponse(`${method} ${endpoint}`, apiError.rateLimit, apiError.headers);
      this.logApiCall(endpoint, method, undefined, undefined, error);
      const errorMsg = this.extractApiError(error);
      this.logger.error(`[X API] ${method} ${endpoint} - Failed: ${errorMsg}`);
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
    const endpoint = `/2/users/:id/likes/:tweet_id`;
    const method = "DELETE";

    try {
      const client = this.getClient(account, accountId);
      const me = await this.getMe(account, accountId);

      this.logger.info(`[X API] ${method} ${endpoint} - tweet: ${tweetId}, me: ${me.id}`);

      const result = await client.v2.unlike(me.id, tweetId);

      this.logger.info(`[X API] ${method} ${endpoint} - Success (tweet: ${tweetId})`);
      this.logger.info(`Unliked tweet ${tweetId}`);
      this.logRateLimitFromClient(client, `users/${me.id}/likes`, `${method} ${endpoint}`);

      return {
        ok: true,
        liked: result.data.liked,
      };
    } catch (error: unknown) {
      const apiError = error as {
        rateLimit?: { limit?: number; remaining?: number; reset?: number };
        headers?: Record<string, string | string[] | undefined>;
      };
      this.logRateLimitFromResponse(`${method} ${endpoint}`, apiError.rateLimit, apiError.headers);
      this.logApiCall(endpoint, method, undefined, undefined, error);
      const errorMsg = this.extractApiError(error);
      this.logger.error(`[X API] ${method} ${endpoint} - Failed: ${errorMsg}`);
      this.logger.error(`Failed to unlike tweet ${tweetId}: ${errorMsg}`);
      return {
        ok: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Log rate limit info from response (success or error). Always uses info level so it is always printed.
   * @param endpointLabel - e.g. "GET /2/users/me" to identify which API call the rate limit applies to.
   */
  private logRateLimitFromResponse(
    endpointLabel: string,
    rateLimit?: { limit?: number; remaining?: number; reset?: number },
    headers?: Record<string, string | string[] | undefined>,
  ): void {
    const parts: string[] = [];
    if (rateLimit) {
      if (rateLimit.limit != null) parts.push(`limit=${rateLimit.limit}`);
      if (rateLimit.remaining != null) parts.push(`remaining=${rateLimit.remaining}`);
      if (rateLimit.reset != null) parts.push(`reset=${rateLimit.reset}`);
    }
    if (!parts.length && headers) {
      const get = (name: string) => {
        const v = headers[name.toLowerCase()] ?? headers[name];
        return Array.isArray(v) ? v[0] : v;
      };
      const limit = get("x-rate-limit-limit");
      const remaining = get("x-rate-limit-remaining");
      const reset = get("x-rate-limit-reset");
      if (limit != null) parts.push(`limit=${limit}`);
      if (remaining != null) parts.push(`remaining=${remaining}`);
      if (reset != null) parts.push(`reset=${reset}`);
    }
    if (parts.length) {
      this.logger.info(`[X API] Rate limit (${endpointLabel}): ${parts.join(", ")}`);
    }
  }

  /**
   * Log rate limit from client's last saved status for the given v2 endpoint path (e.g. "users/me", "tweets").
   * @param endpointLabel - e.g. "GET /2/users/me" to identify which API call the rate limit applies to.
   */
  private logRateLimitFromClient(
    client: TwitterApi,
    endpointPath: string,
    endpointLabel: string,
  ): void {
    try {
      const rl = client.v2.getLastRateLimitStatus(endpointPath);
      if (rl) {
        this.logRateLimitFromResponse(endpointLabel, {
          limit: rl.limit,
          remaining: rl.remaining,
          reset: rl.reset,
        });
      }
    } catch {
      // ignore
    }
  }

  /**
   * Log detailed API request/response info for debugging
   */
  private logApiCall(
    endpoint: string,
    method: string,
    statusCode?: number,
    headers?: Record<string, string | string[] | undefined>,
    error?: unknown,
  ): void {
    this.logger.debug?.(`[X API] ${method} ${endpoint}`);

    if (statusCode) {
      this.logger.debug?.(`[X API] Response status: ${statusCode}`);
    }

    if (headers) {
      // Log rate limit headers
      const rateLimitHeaders = [
        "x-rate-limit-limit",
        "x-rate-limit-remaining",
        "x-rate-limit-reset",
        "x-app-rate-limit-limit",
        "x-app-rate-limit-remaining",
        "x-app-rate-limit-reset",
      ];
      for (const header of rateLimitHeaders) {
        const value = headers[header];
        if (value) {
          this.logger.debug?.(`[X API] ${header}: ${value}`);
        }
      }
    }

    if (error) {
      const apiError = error as {
        code?: number;
        data?: { detail?: string; title?: string; errors?: Array<{ message?: string }> };
        headers?: Record<string, string | string[] | undefined>;
      };
      if (apiError.code) {
        this.logger.error(`[X API] Error code: ${apiError.code}`);
      }
      if (apiError.data) {
        this.logger.error(`[X API] Error details: ${JSON.stringify(apiError.data)}`);
      }
      if (apiError.headers) {
        this.logApiCall(endpoint, method, apiError.code, apiError.headers);
      }
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
      headers?: Record<string, string | string[] | undefined>;
    };
    if (apiError.code) {
      errorMsg = `HTTP ${apiError.code} - ${errorMsg}`;
    }
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
