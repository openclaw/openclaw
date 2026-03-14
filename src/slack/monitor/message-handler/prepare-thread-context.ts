import { formatInboundEnvelope } from "../../../auto-reply/envelope.js";
import { readSessionUpdatedAt } from "../../../config/sessions.js";
import {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
} from "../../../config/sessions/reset.js";
import { logVerbose } from "../../../globals.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import {
  resolveSlackMedia,
  resolveSlackThreadHistory,
  type SlackMediaResult,
  type SlackThreadStarter,
} from "../media.js";

export type SlackThreadContextData = {
  threadStarterBody: string | undefined;
  threadHistoryBody: string | undefined;
  threadSessionPreviousTimestamp: number | undefined;
  threadLabel: string | undefined;
  threadStarterMedia: SlackMediaResult[] | null;
  isEffectivelyNewSession: boolean;
};

/**
 * Result of checking thread session freshness.
 * Returns both the freshness status AND the session timestamp,
 * allowing callers to avoid a redundant session store read.
 */
export type ThreadSessionFreshnessResult = {
  fresh: boolean;
  timestamp: number | undefined;
};

/**
 * Check if a thread session is fresh enough to allow implicit mentions.
 * Used to determine whether the bot should auto-reply to thread messages
 * without an explicit @mention, based on the configured session timeout.
 *
 * Returns both freshness status and the session timestamp. The timestamp
 * is returned so callers can pass it to other functions (like
 * resolveSlackThreadContextData) to avoid redundant session store reads.
 *
 * @param params - Store path, session key, and Slack context
 * @returns Object with fresh (boolean) and timestamp (number | undefined)
 */
export function checkThreadSessionFreshness(params: {
  storePath: string;
  sessionKey: string;
  ctx: SlackMonitorContext;
}): ThreadSessionFreshnessResult {
  const threadSessionPreviousTimestamp = readSessionUpdatedAt({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    skipCache: true,
  });

  // No previous timestamp = truly new session, not stale
  if (!threadSessionPreviousTimestamp) {
    return { fresh: true, timestamp: undefined };
  }

  // Check if the existing session is stale
  const channelReset = resolveChannelResetConfig({
    sessionCfg: params.ctx.cfg.session,
    channel: "slack",
  });
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg: params.ctx.cfg.session,
    resetType: "thread",
    resetOverride: channelReset,
  });
  const freshness = evaluateSessionFreshness({
    updatedAt: threadSessionPreviousTimestamp,
    now: Date.now(),
    policy: resetPolicy,
  });

  return { fresh: freshness.fresh, timestamp: threadSessionPreviousTimestamp };
}

export async function resolveSlackThreadContextData(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  isThreadReply: boolean;
  threadTs: string | undefined;
  threadStarter: SlackThreadStarter | null;
  roomLabel: string;
  storePath: string;
  sessionKey: string;
  envelopeOptions: ReturnType<
    typeof import("../../../auto-reply/envelope.js").resolveEnvelopeFormatOptions
  >;
  effectiveDirectMedia: SlackMediaResult[] | null;
  /**
   * Optional cached session timestamp from a previous read.
   * If provided, this function will use it instead of reading from the session store,
   * avoiding a redundant I/O operation. This is an optimization to reduce the number
   * of session store reads per thread message from 2 to 1.
   */
  threadSessionPreviousTimestamp?: number | undefined;
}): Promise<SlackThreadContextData> {
  let threadStarterBody: string | undefined;
  let threadHistoryBody: string | undefined;
  let threadSessionPreviousTimestamp: number | undefined;
  let threadLabel: string | undefined;
  let threadStarterMedia: SlackMediaResult[] | null = null;
  // Track if this is effectively a new session (truly new or stale) for thread context loading
  let isEffectivelyNewSession = false;

  if (!params.isThreadReply || !params.threadTs) {
    return {
      threadStarterBody,
      threadHistoryBody,
      threadSessionPreviousTimestamp,
      threadLabel,
      threadStarterMedia,
      isEffectivelyNewSession,
    };
  }

  const starter = params.threadStarter;
  if (starter?.text) {
    threadStarterBody = starter.text;
    const snippet = starter.text.replace(/\s+/g, " ").slice(0, 80);
    threadLabel = `Slack thread ${params.roomLabel}${snippet ? `: ${snippet}` : ""}`;
    if (!params.effectiveDirectMedia && starter.files && starter.files.length > 0) {
      threadStarterMedia = await resolveSlackMedia({
        files: starter.files,
        token: params.ctx.botToken,
        maxBytes: params.ctx.mediaMaxBytes,
      });
      if (threadStarterMedia) {
        const starterPlaceholders = threadStarterMedia.map((item) => item.placeholder).join(", ");
        logVerbose(`slack: hydrated thread starter file ${starterPlaceholders} from root message`);
      }
    }
  } else {
    threadLabel = `Slack thread ${params.roomLabel}`;
  }

  const threadInitialHistoryLimit = params.account.config?.thread?.initialHistoryLimit ?? 20;
  // CRITICAL: Skip cache for session freshness check to match initSessionState behavior
  // and avoid incorrect thread context loading decisions (stale cache could cause
  // loading history when session is actually fresh, or vice versa)
  // OPTIMIZATION: Use the cached timestamp from the earlier freshness check if available,
  // otherwise read from the session store. This reduces I/O from 2 reads to 1 read per thread message.
  if (params.threadSessionPreviousTimestamp !== undefined) {
    // Use cached timestamp from earlier freshness check (cache hit)
    threadSessionPreviousTimestamp = params.threadSessionPreviousTimestamp;
  } else {
    // No cached timestamp available, read from session store (fallback path)
    threadSessionPreviousTimestamp = readSessionUpdatedAt({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      skipCache: true,
    });
  }

  // Determine if this is effectively a new session (either truly new or stale):
  // - No previous timestamp = truly new session
  // - Previous timestamp exists but session is stale (will be reset by initSessionState)
  isEffectivelyNewSession = !threadSessionPreviousTimestamp;
  if (threadSessionPreviousTimestamp) {
    // Session exists - check if it's stale (will be reset)
    // NOTE: Must use provider name (not room ID) to match what initSessionState does
    // via ctx.OriginatingChannel, so both use the same reset policy lookup
    const channelReset = resolveChannelResetConfig({
      sessionCfg: params.ctx.cfg.session,
      channel: "slack",
    });
    const resetPolicy = resolveSessionResetPolicy({
      sessionCfg: params.ctx.cfg.session,
      resetType: "thread",
      resetOverride: channelReset,
    });
    const freshness = evaluateSessionFreshness({
      updatedAt: threadSessionPreviousTimestamp,
      now: Date.now(),
      policy: resetPolicy,
    });
    // If session is stale, initSessionState will create a new session
    isEffectivelyNewSession = !freshness.fresh;
  }

  // Only fetch thread history for NEW or STALE sessions (fresh sessions already have this context in their transcript)
  if (threadInitialHistoryLimit > 0 && isEffectivelyNewSession) {
    const threadHistory = await resolveSlackThreadHistory({
      channelId: params.message.channel,
      threadTs: params.threadTs,
      client: params.ctx.app.client,
      currentMessageTs: params.message.ts,
      limit: threadInitialHistoryLimit,
    });

    if (threadHistory.length > 0) {
      const uniqueUserIds = [
        ...new Set(
          threadHistory.map((item) => item.userId).filter((id): id is string => Boolean(id)),
        ),
      ];
      const userMap = new Map<string, { name?: string }>();
      await Promise.all(
        uniqueUserIds.map(async (id) => {
          const user = await params.ctx.resolveUserName(id);
          if (user) {
            userMap.set(id, user);
          }
        }),
      );

      const historyParts: string[] = [];
      for (const historyMsg of threadHistory) {
        const msgUser = historyMsg.userId ? userMap.get(historyMsg.userId) : null;
        const msgSenderName =
          msgUser?.name ?? (historyMsg.botId ? `Bot (${historyMsg.botId})` : "Unknown");
        const isBot = Boolean(historyMsg.botId);
        const role = isBot ? "assistant" : "user";
        const msgWithId = `${historyMsg.text}\n[slack message id: ${historyMsg.ts ?? "unknown"} channel: ${params.message.channel}]`;
        historyParts.push(
          formatInboundEnvelope({
            channel: "Slack",
            from: `${msgSenderName} (${role})`,
            timestamp: historyMsg.ts ? Math.round(Number(historyMsg.ts) * 1000) : undefined,
            body: msgWithId,
            chatType: "channel",
            envelope: params.envelopeOptions,
          }),
        );
      }
      threadHistoryBody = historyParts.join("\n\n");
      logVerbose(
        `slack: populated thread history with ${threadHistory.length} messages for new or stale session`,
      );
    }
  }

  return {
    threadStarterBody,
    threadHistoryBody,
    threadSessionPreviousTimestamp,
    threadLabel,
    threadStarterMedia,
    isEffectivelyNewSession,
  };
}
