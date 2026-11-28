import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import { requestSharedHistory } from "./chat-history-request.ts";
import {
  type ChatHistoryDeltaResult,
  type ChatHistoryResetResult,
  isHistoryCursor,
  resolveChatHistoryPagination,
  historySessionId,
} from "./chat-history-snapshot.ts";
import {
  appendChatMessageToCache,
  cacheChatSessionSnapshot,
  projectChatTranscriptMetadata,
  readChatSessionSnapshot,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import type { SessionSnapshotStore } from "./session-snapshot-store.ts";

type ChatSessionSnapshotRequestResult =
  | { kind: "snapshot"; snapshot: ChatSessionSnapshot }
  | (ChatHistoryDeltaResult & { sessionInfo: GatewaySessionRow })
  | ChatHistoryResetResult;

async function requestChatSessionSnapshot(
  client: GatewayBrowserClient,
  sessionKey: string,
  consumerOwner: object,
  isCurrentConsumer: () => boolean,
  cursor?: string,
  signal?: AbortSignal,
): Promise<ChatSessionSnapshotRequestResult> {
  const method = "chat.history";
  const requestModeKey = cursor === undefined ? "page" : `cursor:${cursor}`;
  const requestKey = `prefetch\u0000${method}\u0000${sessionKey}\u0000${requestModeKey}`;
  const result = await requestSharedHistory(
    null,
    client,
    requestKey,
    method,
    sessionKey,
    undefined,
    consumerOwner,
    { isCurrent: isCurrentConsumer, signal },
    cursor,
  );
  if (isHistoryCursor(result)) {
    if (result.kind === "reset") {
      return result;
    }
    if (!result.sessionInfo) {
      throw new Error("chat history delta omitted uncached session metadata");
    }
    return { ...result, sessionInfo: result.sessionInfo };
  }
  const sessionInfo = result.sessionInfo;
  return {
    kind: "snapshot",
    snapshot: {
      ...(result.deltaCursor !== undefined ? { deltaCursor: result.deltaCursor } : {}),
      ...(Object.hasOwn(sessionInfo ?? {}, "activeLeafEntryId")
        ? { displayedLeafEntryId: sessionInfo?.activeLeafEntryId?.trim() || null }
        : {}),
      transcriptMetadata: sessionInfo ? projectChatTranscriptMetadata(sessionInfo) : undefined,
      messages: visibleChatHistoryMessages(result.messages),
      pagination: resolveChatHistoryPagination(result),
      sessionId: historySessionId(result),
      historyState: result.stateRevision
        ? {
            stateRevision: result.stateRevision,
            pendingInputs: result.pendingInputs,
            sessionInfo,
          }
        : undefined,
    },
  };
}

export async function prefetchSessionHistory({
  client,
  sessionKey,
  snapshotKey,
  cache,
  snapshotHost,
  store,
  owner,
  signal,
  isTargetCurrent,
  stillIntended,
  isOpen,
  noteAttempt,
}: {
  client: GatewayBrowserClient;
  sessionKey: string;
  snapshotKey: string;
  cache: ChatMessageCache;
  snapshotHost: Parameters<typeof readChatSessionSnapshot>[1];
  store: SessionSnapshotStore;
  owner: object;
  signal: AbortSignal;
  isTargetCurrent: () => boolean;
  stillIntended: () => boolean;
  isOpen: () => boolean;
  noteAttempt: () => void;
}) {
  // Hydration and cursor removal are synchronous owned writes. Renew
  // only after checking the previous claim, before another await.
  let ownsCache = store.captureReadScope(snapshotKey);
  const isCurrent = () => !signal.aborted && isTargetCurrent() && ownsCache.isCurrent();
  // Every network request re-reads readiness: a presented pane can start
  // loading during the persisted snapshot read or between history pages.
  const mayRequest = () => isCurrent() && stillIntended();
  const target = { sessionKey };
  const readSnapshot = () => readChatSessionSnapshot(cache, snapshotHost, target);
  const cacheSnapshot = (value: ChatSessionSnapshot) =>
    cacheChatSessionSnapshot(cache, snapshotHost, target, value);
  try {
    if (!mayRequest() || isOpen()) {
      return;
    }
    let existing = readSnapshot();
    if (!existing && store.readSavedAt(snapshotKey) !== null) {
      existing = await store.read(snapshotKey);
      if (!mayRequest()) {
        return;
      }
      if (existing) {
        cacheSnapshot(existing);
        ownsCache.dispose();
        ownsCache = store.captureReadScope(snapshotKey);
      }
    }
    // The cooldown counts network attempts; a candidate yielded before its
    // request stays eligible for the cycle after the presented transcript commits.
    noteAttempt();
    let result = await requestChatSessionSnapshot(
      client,
      sessionKey,
      owner,
      mayRequest,
      existing?.deltaCursor,
      signal,
    );
    if (!isCurrent()) {
      return;
    }
    if (result.kind === "reset") {
      if (existing?.deltaCursor !== undefined) {
        const { deltaCursor: _deltaCursor, ...withoutCursor } = existing;
        cacheSnapshot(withoutCursor);
        existing = withoutCursor;
        ownsCache.dispose();
        ownsCache = store.captureReadScope(snapshotKey);
      }
      if (!mayRequest()) {
        return;
      }
      result = await requestChatSessionSnapshot(
        client,
        sessionKey,
        owner,
        mayRequest,
        undefined,
        signal,
      );
      if (!isCurrent()) {
        return;
      }
    }
    if (isOpen()) {
      return;
    }
    let cached: ChatSessionSnapshot;
    if (result.kind === "delta") {
      for (const payload of result.messages) {
        const event = asOptionalRecord(payload);
        if (!event || !Object.hasOwn(event, "message")) {
          continue;
        }
        appendChatMessageToCache(cache, snapshotHost, target, event.message, event);
      }
      const updated = readSnapshot();
      if (!updated) {
        return;
      }
      cached = {
        ...updated,
        // Prefetch does not own transient run replay. Keep the prior cursor
        // so the opening pane can consume the same authoritative snapshot.
        ...(result.inFlightRun ? {} : { deltaCursor: result.deltaCursor }),
        ...(Object.hasOwn(result.sessionInfo, "activeLeafEntryId")
          ? { displayedLeafEntryId: result.sessionInfo.activeLeafEntryId?.trim() || null }
          : {}),
        sessionId: result.sessionInfo.sessionId?.trim() || updated.sessionId,
        transcriptMetadata: projectChatTranscriptMetadata(result.sessionInfo),
      };
    } else if (result.kind === "snapshot") {
      cached = result.snapshot;
    } else {
      throw new Error("chat history page request returned a cursor reset");
    }
    cacheSnapshot(cached);
  } catch (error) {
    if (!signal.aborted) {
      console.debug(`[chat-session-prefetch] history fetch failed for ${sessionKey}`, error);
    }
  } finally {
    ownsCache.dispose();
  }
}
