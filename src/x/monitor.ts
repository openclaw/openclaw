/**
 * X channel monitor - polls for mentions and routes to agents.
 *
 * This monitor polls the X mentions timeline at a configurable interval,
 * processes incoming mentions, resolves agent routes, and handles replies.
 */

import type { OpenClawConfig } from "../config/config.js";
import type { XAccountConfig, XMention, XLogSink } from "./types.js";
import { getOrCreateClientManager } from "./client.js";
import { loadXPollState, updateXLastTweetId } from "./state.js";
import { chunkTextForX, X_CHAR_LIMIT } from "./send.js";

export type XMonitorDeps = {
  resolveAgentRoute: (params: {
    cfg: OpenClawConfig;
    channel: string;
    accountId: string;
    peer: { kind: string; id: string };
  }) => { sessionKey: string; accountId: string; agentId: string };
  formatAgentEnvelope: (params: {
    channel: string;
    from: string;
    timestamp?: number;
    envelope: unknown;
    body: string;
  }) => string;
  resolveEnvelopeFormatOptions: (cfg: OpenClawConfig) => unknown;
  finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
  resolveStorePath: (store: string | undefined, opts: { agentId: string }) => string;
  recordInboundSession: (params: {
    storePath: string;
    sessionKey: string;
    ctx: Record<string, unknown>;
    onRecordError: (err: unknown) => void;
  }) => Promise<void>;
  dispatchReply: (params: {
    ctx: Record<string, unknown>;
    cfg: OpenClawConfig;
    deliver: (payload: { text?: string }) => Promise<void>;
  }) => Promise<void>;
};

export type XMonitorOptions = {
  account: XAccountConfig;
  accountId: string;
  config: OpenClawConfig;
  abortSignal: AbortSignal;
  deps: XMonitorDeps;
  logger: XLogSink;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type XMonitorResult = {
  stop: () => void;
};

const DEFAULT_POLL_INTERVAL_SECONDS = 60;

/**
 * Check if a mention is allowed to trigger the bot.
 */
function checkAccessControl(params: {
  mention: XMention;
  account: XAccountConfig;
  botUserId: string;
}): { allowed: boolean; reason?: string } {
  const { mention, account, botUserId } = params;

  // Ignore our own tweets
  if (mention.authorId === botUserId) {
    return { allowed: false, reason: "own_tweet" };
  }

  // If no allowFrom configured, allow all
  const allowFrom = account.allowFrom;
  if (!allowFrom || allowFrom.length === 0) {
    return { allowed: true };
  }

  // Check if author is in allowlist
  const isAllowed = allowFrom.includes(mention.authorId);
  if (!isAllowed) {
    return { allowed: false, reason: "not_in_allowlist" };
  }

  return { allowed: true };
}

/**
 * Process an incoming X mention and dispatch to agent.
 */
async function processXMention(params: {
  mention: XMention;
  account: XAccountConfig;
  accountId: string;
  config: OpenClawConfig;
  deps: XMonitorDeps;
  logger: XLogSink;
  botUserId: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { mention, account, accountId, config, deps, logger, botUserId, statusSink } = params;

  const route = deps.resolveAgentRoute({
    cfg: config,
    channel: "x",
    accountId,
    peer: {
      kind: "direct",
      id: mention.authorId,
    },
  });

  const rawBody = mention.text;
  const body = deps.formatAgentEnvelope({
    channel: "X",
    from: mention.authorUsername ?? mention.authorId,
    timestamp: mention.createdAt?.getTime(),
    envelope: deps.resolveEnvelopeFormatOptions(config),
    body: rawBody,
  });

  const ctxPayload = deps.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `x:user:${mention.authorId}`,
    To: `x:user:${botUserId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: mention.conversationId ?? mention.id,
    SenderName: mention.authorName ?? mention.authorUsername ?? mention.authorId,
    SenderId: mention.authorId,
    SenderUsername: mention.authorUsername,
    Provider: "x",
    Surface: "x",
    MessageSid: mention.id,
    OriginatingChannel: "x",
    OriginatingTo: `x:tweet:${mention.id}`,
  });

  const storePath = deps.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  await deps.recordInboundSession({
    storePath,
    sessionKey: (ctxPayload.SessionKey as string) ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      logger.error(`Failed updating session meta: ${String(err)}`);
    },
  });

  const clientManager = getOrCreateClientManager(accountId, logger);

  await deps.dispatchReply({
    ctx: ctxPayload,
    cfg: config,
    deliver: async (payload) => {
      if (!payload.text) {
        logger.error(`No text to send in reply payload`);
        return;
      }

      // Chunk text if needed (X has 280 char limit)
      const chunks = chunkTextForX(payload.text, X_CHAR_LIMIT);

      // Send each chunk as a reply (thread them together)
      let lastTweetId = mention.id;
      for (const chunk of chunks) {
        const result = await clientManager.replyToTweet(account, accountId, lastTweetId, chunk);
        if (result.ok && result.tweetId) {
          lastTweetId = result.tweetId;
        } else {
          logger.error(`Failed to send chunk: ${result.error}`);
          break;
        }
      }

      statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
}

/**
 * Main monitor provider for X.
 *
 * Polls the mentions timeline and processes new mentions.
 */
export async function monitorXProvider(options: XMonitorOptions): Promise<XMonitorResult> {
  const { account, accountId, config, abortSignal, deps, logger, statusSink } = options;

  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const clientManager = getOrCreateClientManager(accountId, logger);

  // Get bot user info
  let botUserId: string;
  let botUsername: string;
  try {
    const me = await clientManager.getMe(account, accountId);
    botUserId = me.id;
    botUsername = me.username;
    logger.info(`X monitor started for @${botUsername} (${botUserId})`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to get bot user info: ${errorMsg}`);
    throw error;
  }

  // Get data directory for state persistence
  const dataDir = config.session?.store ?? ".moltbot";

  // Load last poll state
  const state = loadXPollState(dataDir, accountId);
  let sinceId = state.lastTweetId;

  const pollIntervalMs = (account.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000;

  async function poll() {
    if (stopped) return;

    try {
      logger.debug?.(`Polling X mentions${sinceId ? ` since ${sinceId}` : ""}`);

      const { mentions, newestId } = await clientManager.getMentions(account, accountId, sinceId);

      if (mentions.length > 0) {
        logger.info(`Received ${mentions.length} new mention(s)`);
        statusSink?.({ lastInboundAt: Date.now() });

        // Process mentions in chronological order (oldest first)
        const sorted = [...mentions].reverse();

        for (const mention of sorted) {
          if (stopped) break;

          // Access control check
          const access = checkAccessControl({
            mention,
            account,
            botUserId,
          });

          if (!access.allowed) {
            logger.debug?.(`Skipping mention ${mention.id}: ${access.reason}`);
            continue;
          }

          // Process the mention
          try {
            await processXMention({
              mention,
              account,
              accountId,
              config,
              deps,
              logger,
              botUserId,
              statusSink,
            });
          } catch (err) {
            logger.error(`Failed to process mention ${mention.id}: ${String(err)}`);
          }
        }

        // Update state with newest ID
        if (newestId) {
          sinceId = newestId;
          updateXLastTweetId(dataDir, accountId, newestId);
        }
      } else {
        logger.debug?.("No new mentions");
      }
    } catch (err) {
      logger.error(`Poll failed: ${String(err)}`);
    }

    // Schedule next poll
    if (!stopped) {
      pollTimer = setTimeout(poll, pollIntervalMs);
    }
  }

  // Start polling
  void poll();

  const stop = () => {
    stopped = true;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    logger.info(`X monitor stopped for @${botUsername}`);
  };

  abortSignal.addEventListener("abort", stop, { once: true });

  return { stop };
}
