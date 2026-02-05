/**
 * X (Twitter) channel types.
 */

/**
 * Account configuration for X channel
 */
export interface XAccountConfig {
  /** Twitter/X Consumer Key (API Key) */
  consumerKey: string;
  /** Twitter/X Consumer Secret (API Secret) */
  consumerSecret: string;
  /** Twitter/X Access Token */
  accessToken: string;
  /** Twitter/X Access Token Secret */
  accessTokenSecret: string;
  /** Enable this account */
  enabled?: boolean;
  /** Polling interval in seconds (default: 60) */
  pollIntervalSeconds?: number;
  /** Allowlist of X user IDs who can mention the bot (mention → reply). When set, only these users can trigger. Server config only. */
  allowFrom?: string[];
  /**
   * Allowlist of X user IDs who can trigger proactive X actions (follow, like, reply, dm).
   * Separate from allowFrom: use this for auto-operations; do not reuse mention allowlist.
   * When request is from X (mention), the mentioner must be in this list to use x-follow, x-like, x-reply, x-dm.
   * Server config only.
   */
  actionsAllowFrom?: string[];
  /** Account display name (for UI) */
  name?: string;
  /** HTTP proxy URL for API requests (e.g., http://127.0.0.1:7890) */
  proxy?: string;
}

/**
 * X mention from the API
 */
export interface XMention {
  /** Tweet ID */
  id: string;
  /** Tweet text content */
  text: string;
  /** Author's user ID */
  authorId: string;
  /** Author's username (handle) */
  authorUsername?: string;
  /** Author's display name */
  authorName?: string;
  /** Tweet creation timestamp */
  createdAt?: Date;
  /** ID of tweet being replied to (if this is a reply) */
  inReplyToTweetId?: string;
  /** Conversation ID */
  conversationId?: string;
}

/**
 * Result from sending a tweet/reply
 */
export interface XSendResult {
  ok: boolean;
  error?: string;
  tweetId?: string;
}

/**
 * State tracker for polling
 */
export interface XPollState {
  /** Last processed tweet ID (for since_id) */
  lastTweetId?: string;
  /** Timestamp of last successful poll */
  lastPollAt?: number;
}

/**
 * Log sink interface
 */
export interface XLogSink {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

/**
 * Result from follow/unfollow operations
 */
export interface XFollowResult {
  ok: boolean;
  error?: string;
  /** Whether the user is now being followed */
  following?: boolean;
}

/**
 * Result from sending a direct message
 */
export interface XDmResult {
  ok: boolean;
  error?: string;
  /** The DM event ID */
  dmId?: string;
  /** The conversation ID */
  conversationId?: string;
}

/**
 * Result from like/unlike operations
 */
export interface XLikeResult {
  ok: boolean;
  error?: string;
  /** Whether the tweet is now liked */
  liked?: boolean;
}

/**
 * X user info from lookup
 */
export interface XUserInfo {
  id: string;
  username: string;
  name: string;
}

/**
 * X tweet data
 */
export interface XTweet {
  id: string;
  text: string;
  authorId?: string;
  createdAt?: Date;
  conversationId?: string;
}
