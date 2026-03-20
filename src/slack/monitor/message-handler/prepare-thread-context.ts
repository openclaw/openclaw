import { formatInboundEnvelope } from "../../../auto-reply/envelope.js";
import { readSessionUpdatedAt } from "../../../config/sessions.js";
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
};

function normalizeForRetryCheck(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

// Existing thread sessions only need a compact refresh window to pick up new human replies
// without replaying the full thread on every turn.
const DEFAULT_EXISTING_THREAD_REFRESH_LIMIT = 8;

function resolveThreadHistoryLimit(params: {
  initialHistoryLimit: number;
  existingSessionRefreshLimit: number;
  hasExistingThreadSession: boolean;
}): number {
  if (params.initialHistoryLimit <= 0) {
    return 0;
  }
  if (!params.hasExistingThreadSession) {
    return params.initialHistoryLimit;
  }
  if (params.existingSessionRefreshLimit === 0) {
    return 0;
  }
  const refreshLimit = Math.max(params.existingSessionRefreshLimit, 1);
  return Math.min(params.initialHistoryLimit, refreshLimit);
}

function resolveReporterUserId(params: {
  starter: SlackThreadStarter | null;
  parentUserId?: string;
}): string | undefined {
  const starterUserId = params.starter?.userId?.trim();
  if (starterUserId) {
    return starterUserId;
  }
  // Slack thread replies expose parent_user_id as the thread-root author when
  // the root fetch omitted a user id, so this is the closest reporter fallback.
  const parentUserId = params.parentUserId?.trim();
  return parentUserId || undefined;
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
}): Promise<SlackThreadContextData> {
  let threadStarterBody: string | undefined;
  let threadHistoryBody: string | undefined;
  let threadSessionPreviousTimestamp: number | undefined;
  let threadLabel: string | undefined;
  let threadStarterMedia: SlackMediaResult[] | null = null;

  if (!params.isThreadReply || !params.threadTs) {
    return {
      threadStarterBody,
      threadHistoryBody,
      threadSessionPreviousTimestamp,
      threadLabel,
      threadStarterMedia,
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
  const existingSessionRefreshLimit =
    params.account.config?.thread?.existingSessionRefreshLimit ??
    DEFAULT_EXISTING_THREAD_REFRESH_LIMIT;
  threadSessionPreviousTimestamp = readSessionUpdatedAt({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
  });

  const hasExistingThreadSession = threadSessionPreviousTimestamp !== undefined;
  const threadHistoryLimit = resolveThreadHistoryLimit({
    initialHistoryLimit: threadInitialHistoryLimit,
    existingSessionRefreshLimit,
    hasExistingThreadSession,
  });

  if (threadHistoryLimit > 0) {
    // For existing sessions, pass oldest to avoid paginating the full thread.
    // threadSessionPreviousTimestamp is in ms (Date.now()); Slack uses seconds.
    const oldest =
      hasExistingThreadSession && threadSessionPreviousTimestamp
        ? (threadSessionPreviousTimestamp / 1000).toFixed(6)
        : undefined;

    const threadHistory = await resolveSlackThreadHistory({
      channelId: params.message.channel,
      threadTs: params.threadTs,
      client: params.ctx.app.client,
      currentMessageTs: params.message.ts,
      limit: threadHistoryLimit,
      oldest,
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
      const reporterUserId = resolveReporterUserId({
        starter,
        parentUserId: params.message.parent_user_id,
      });
      if (!starter?.userId && reporterUserId) {
        logVerbose(
          `slack: thread history reporter fallback using parent_user_id for ${params.message.channel} ` +
            `thread=${params.threadTs}`,
        );
      }
      for (const historyMsg of threadHistory) {
        // Avoid self-conditioning on stale assistant status/tool-capability claims.
        // Applies to both new session bootstrap and existing session refresh.
        if (historyMsg.botId) {
          continue;
        }
        const msgUser = historyMsg.userId ? userMap.get(historyMsg.userId) : null;
        const msgSenderName = msgUser?.name ?? "Unknown";
        const role = "user";
        const participantRole =
          historyMsg.userId && historyMsg.userId === reporterUserId ? "reporter" : "participant";
        const msgWithId =
          `${historyMsg.text}\n[slack message id: ${historyMsg.ts ?? "unknown"} ` +
          `channel: ${params.message.channel}${
            historyMsg.userId ? ` slack user id: ${historyMsg.userId} role: ${participantRole}` : ""
          }]`;
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
      if (historyParts.length > 0) {
        threadHistoryBody = historyParts.join("\n\n");
      }

      const normalizedCurrent = normalizeForRetryCheck(params.message.text);
      const hasRepeatedQuestion =
        normalizedCurrent.length >= 16 &&
        threadHistory.some(
          (entry) => !entry.botId && normalizeForRetryCheck(entry.text) === normalizedCurrent,
        );
      if (hasRepeatedQuestion) {
        const retryHint =
          "Retry policy: same question repeated in thread. Re-run live checks/tools now and avoid reusing a prior answer.";
        threadHistoryBody = threadHistoryBody ? `${retryHint}\n\n${threadHistoryBody}` : retryHint;
      }

      logVerbose(
        `slack: populated thread history with ${historyParts.length}/${threadHistory.length} ` +
          `messages for ${hasExistingThreadSession ? "existing" : "new"} session`,
      );
    }
  }

  return {
    threadStarterBody,
    threadHistoryBody,
    threadSessionPreviousTimestamp,
    threadLabel,
    threadStarterMedia,
  };
}
