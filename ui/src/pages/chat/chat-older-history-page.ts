import {
  readSessionMessageIdentity,
  reduceSessionProjection,
} from "@openclaw/gateway-client/browser";
import { prependUniqueNativeMessages } from "../../lib/chat/history-message-identity.ts";
import {
  hasAutomationActivity,
  loadAutomationProjection,
} from "./chat-automation-projection-loader.ts";
import { hasVisibleOlderHistoryPage } from "./chat-history-page-visibility.ts";
import {
  commitCurrentChatHistorySnapshot,
  reopenChatHistoryBoundary,
  resolveChatHistoryPagination,
  type ChatHistoryResult,
} from "./chat-history-snapshot.ts";
import { requiresChatHistoryReload, reloadChatHistoryWindow } from "./chat-history.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  getChatSessionProjection,
  publishChatSessionProjectionMessages,
  retireChatSubmissionDisplay,
} from "./history-merge.ts";
import { scheduleChatScroll } from "./scroll.ts";

/** Reconcile an admitted older response only; ordinary transcript construction never prepends. */
export async function applyOlderHistoryPage({
  state,
  paneId,
  result,
  expectedSessionId,
  boundary,
  requestedCursor,
  totalMessages,
  readerIntent,
  isCurrent,
  clearStaged,
}: {
  state: ChatPageHost;
  paneId: string;
  result: ChatHistoryResult;
  expectedSessionId: string;
  boundary?: string | null;
  requestedCursor?: string | null;
  totalMessages?: number;
  readerIntent: boolean;
  isCurrent: () => boolean;
  clearStaged: () => void;
}) {
  if (requiresChatHistoryReload(result, expectedSessionId, boundary)) {
    clearStaged();
    await reloadChatHistoryWindow(state);
    return { prepended: true, visible: true };
  }
  const nextPagination = resolveChatHistoryPagination(result, totalMessages);
  if (boundary) {
    // Probe rows never enter presentation. This attempt spends one of the
    // same three reader slots; the next attempt consumes the reopened edge.
    reopenChatHistoryBoundary(state, boundary, nextPagination);
    return { prepended: true, visible: !nextPagination.hasMore };
  }
  if (nextPagination.hasMore && nextPagination.olderCursor === requestedCursor) {
    throw new Error("History returned the same older boundary. Reload the session to retry.");
  }
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const projector =
    readerIntent && messages.some(hasAutomationActivity)
      ? await loadAutomationProjection()
      : undefined;
  if (!isCurrent()) {
    return undefined;
  }
  const projection = getChatSessionProjection(state);
  const pendingRunIds = projection.entries.flatMap((entry) =>
    entry.pending && entry.identity?.role === "user" && entry.pendingRunId
      ? [entry.pendingRunId]
      : [],
  );
  if (pendingRunIds.length) {
    const canonicalUsers = messages.filter((message) => {
      const identity = readSessionMessageIdentity(message);
      return (
        identity?.role === "user" &&
        !identity.isImported &&
        (identity.id !== null || identity.sequence !== null)
      );
    });
    // Use canonical adoption without reseeding the existing tail's live
    // provenance or changing the raw order of older-page projections.
    const adopted = reduceSessionProjection(projection, {
      type: "snapshotLoaded",
      messages: canonicalUsers,
      scope: projection.scope,
    });
    const remaining = new Set(
      adopted.entries
        .filter((entry) => entry.pending && entry.identity?.role === "user")
        .map((entry) => entry.pendingRunId),
    );
    retireChatSubmissionDisplay(
      state,
      new Set(pendingRunIds.filter((runId) => !remaining.has(runId))),
    );
  }
  const previousCount = state.chatMessages.length;
  const next = prependUniqueNativeMessages(messages, state.chatMessages);
  const visible =
    !readerIntent ||
    hasVisibleOlderHistoryPage(
      state,
      paneId,
      next.slice(0, next.length - previousCount),
      projector,
    );
  publishChatSessionProjectionMessages(state, next);
  const grew = state.chatMessages.length > previousCount;
  state.chatHistoryPagination = nextPagination;
  commitCurrentChatHistorySnapshot(state);
  scheduleChatScroll(state, false);
  return {
    prepended: grew || nextPagination.hasMore,
    visible,
    stage: nextPagination.hasMore && readerIntent,
  };
}
