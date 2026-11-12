import {
  readSessionMessageIdentity,
  reduceSessionProjection,
  type SessionProjectionEntry,
} from "@openclaw/gateway-client/browser";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  nativeHistoryMessageSourceId,
  nativeHistoryMessageSourceIdentity,
} from "../../lib/chat/history-message-identity.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import { prepareChatHistoryPages } from "./chat-history-page-preparation.ts";
import { hasVisibleOlderHistoryPage } from "./chat-history-page-visibility.ts";
import {
  advanceChatHistoryNavigation,
  type ChatHistoryPagination,
} from "./chat-history-pagination.ts";
import { readChatHistoryRequestBudget } from "./chat-history-request-budget.ts";
import {
  CHAT_HISTORY_REQUEST_LIMIT,
  CHAT_HISTORY_REQUEST_MAX_BYTES,
  CHAT_HISTORY_TOOL_RESULT_MAX_CHARS,
  type ChatHistoryRequestBudget,
} from "./chat-history-request-params.ts";
import {
  attachHistoryActivity,
  type OlderHistorySelector,
  createChatHistoryPageRead,
  chatHistoryPageSelector,
  type StagedOlderHistoryPage,
} from "./chat-history-request.ts";
import { retryChatHistoryRead } from "./chat-history-retry.ts";
import {
  type ChatHistoryResult,
  resolveChatHistoryPagination,
  commitCurrentChatHistorySnapshot,
} from "./chat-history-snapshot.ts";
import {
  prepareChatHistoryPacket,
  chatHistoryWindowBoundary,
  MAX_RESIDENT_SEGMENTS,
} from "./chat-history-window.ts";
import { reloadChatHistoryWindow, requiresChatHistoryReload } from "./chat-history.ts";
import type { ChatState } from "./chat-state-contract.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  getChatSessionProjection,
  readChatSessionProjection,
  publishChatSessionProjection,
  publishChatSessionProjectionMessages,
  readChatLocalOutputEntries,
} from "./history-merge.ts";
import { scheduleChatScroll } from "./scroll.ts";

export function reopenChatHistoryBoundary(
  state: ChatState,
  boundary: string,
  pagination: ChatHistoryPagination,
  direction: "older" | "newer" = "older",
): void {
  const held = chatHistoryWindowBoundary(
    state.chatMessages,
    state.chatHistoryPagination,
    direction,
  );
  if (nativeHistoryMessageSourceIdentity(held) !== boundary) {
    throw new Error(t("chat.thread.earlierInterrupted"));
  }
  const previous = state.chatHistoryPagination;
  // Reopening advances the traversal edge without changing the held wire packet.
  state.chatHistoryPagination = advanceChatHistoryNavigation(previous, pagination, direction);
  commitCurrentChatHistorySnapshot(state);
}

/** Accept all admitted producer receipts before the one resident publication. */
export function admitChatHistoryPages(
  state: ChatState,
  results: readonly ChatHistoryResult[],
  direction: "older" | "newer" | "around",
): "messages" | "coverage" | false {
  const projection = getChatSessionProjection(state);
  const localEntries = readChatLocalOutputEntries(state);
  const prepared = prepareChatHistoryPages(state, results, direction, localEntries);
  if (!prepared.fits) {
    // Around navigation cannot retire a required target after accepting its
    // coverage or receipts; its existing caller surfaces this capacity reason.
    if (direction === "around") {
      throw new Error(t("chat.thread.historyCapacity"));
    }
    return false;
  }
  return commitPreparedChatHistoryPages(
    state,
    results,
    direction,
    projection,
    localEntries,
    prepared,
  );
}

/** Fit and commit one contiguous prefix without exporting prepared authority. */
export function admitChatHistoryPagePrefix(
  state: ChatState,
  results: readonly ChatHistoryResult[],
  direction: "older" | "newer",
): { acceptedCount: number; change: "messages" | "coverage" | false } {
  const previousProjection = readChatSessionProjection(state);
  let localEntries = readChatLocalOutputEntries(state);
  let accepted = results;
  const fit = () => {
    while (accepted.length) {
      const candidate = prepareChatHistoryPages(state, accepted, direction, localEntries);
      if (candidate.fits) {
        return candidate;
      }
      accepted = accepted.slice(0, -1);
    }
    return undefined;
  };
  let prepared = fit();
  if (!prepared) {
    return { acceptedCount: 0, change: false };
  }
  const projection = getChatSessionProjection(state);
  // Initialization or scope binding can publish different resident/local custody.
  // Only an unchanged projection permits reuse of this same-stack fit.
  if (projection !== previousProjection) {
    localEntries = readChatLocalOutputEntries(state);
    prepared = fit();
    if (!prepared) {
      return { acceptedCount: 0, change: false };
    }
  }
  return {
    acceptedCount: accepted.length,
    change: commitPreparedChatHistoryPages(
      state,
      accepted,
      direction,
      projection,
      localEntries,
      prepared,
    ),
  };
}

function commitPreparedChatHistoryPages(
  state: ChatState,
  results: readonly ChatHistoryResult[],
  direction: "older" | "newer" | "around",
  projection: ReturnType<typeof getChatSessionProjection>,
  localEntries: readonly SessionProjectionEntry[],
  prepared: ReturnType<typeof prepareChatHistoryPages>,
): "messages" | "coverage" | false {
  const messages = results.flatMap((result) => result.messages ?? []);
  let acceptedRunIds: ReadonlySet<string> | undefined;
  const pendingRunIds = projection.entries.flatMap((entry) =>
    entry.pending && entry.identity?.role === "user" && entry.pendingRunId
      ? [entry.pendingRunId]
      : [],
  );
  if (pendingRunIds.length) {
    const adopted = reduceSessionProjection(projection, {
      type: "snapshotLoaded",
      scope: projection.scope,
      messages: messages.filter((message) => {
        const identity = readSessionMessageIdentity(message);
        return (
          identity?.role === "user" &&
          !identity.isImported &&
          (identity.id !== null || identity.sequence !== null)
        );
      }),
    });
    const remaining = new Set(
      adopted.entries.filter((entry) => entry.pending).map((entry) => entry.pendingRunId),
    );
    acceptedRunIds = new Set(pendingRunIds.filter((runId) => !remaining.has(runId)));
  }
  const previous = state.chatMessages;
  const previousPagination = state.chatHistoryPagination;
  const localOutputs = localEntries.map((entry) => entry.message);
  state.chatHistoryPagination = prepared.pagination;
  if (direction === "around") {
    publishChatSessionProjection(
      state,
      reduceSessionProjection(projection, {
        type: "residencyChanged",
        messages: [...prepared.messages, ...localOutputs],
      }),
      { acceptedRunIds },
    );
  } else {
    publishChatSessionProjectionMessages(state, prepared.messages, { acceptedRunIds });
  }
  commitCurrentChatHistorySnapshot(state);
  if (state.chatMessages.some((message) => !previous.includes(message))) {
    return "messages";
  }
  const admitted = state.chatHistoryPagination;
  // Rejected pages cannot advance navigation. Hidden pages can still certify
  // a new edge, even when no displayed body enters the resident window.
  return admitted.hasMore !== previousPagination.hasMore ||
    (admitted.hasMore &&
      previousPagination.hasMore &&
      (admitted.olderCursor !== previousPagination.olderCursor ||
        admitted.needsBoundary !== previousPagination.needsBoundary)) ||
    admitted.hasNewer !== previousPagination.hasNewer ||
    admitted.newerCursor !== previousPagination.newerCursor ||
    admitted.needsNewerBoundary !== previousPagination.needsNewerBoundary
    ? "coverage"
    : false;
}

export async function requestOlderChatHistoryPage(
  client: GatewayBrowserClient,
  sessionKey: string,
  requestAgentId: string | undefined,
  selector: OlderHistorySelector,
  isCurrent: () => boolean,
  signal?: AbortSignal,
  requestBudget?: ChatHistoryRequestBudget,
): Promise<ChatHistoryResult & { requestBudget?: ChatHistoryRequestBudget; smallOnly?: boolean }> {
  let budget = requestBudget;
  let smallOnly = false;
  for (;;) {
    const issued = {
      limit: CHAT_HISTORY_REQUEST_LIMIT,
      maxBytes: CHAT_HISTORY_REQUEST_MAX_BYTES,
      ...("cursor" in selector && !selector.limit ? budget : {}),
      ...("limit" in selector ? { limit: selector.limit } : {}),
    };
    // Classify synchronously so rejected raw bodies never enter suspended loop
    // bindings and remain retained while this cursor is reread under small bounds.
    const accepted = await retryChatHistoryRead({
      method: "chat.history",
      controller: new AbortController(),
      signal,
      isCurrent,
      request: (readSignal) =>
        client.request<ChatHistoryResult>(
          "chat.history",
          {
            sessionKey,
            toolResultMaxChars: CHAT_HISTORY_TOOL_RESULT_MAX_CHARS,
            ...(requestAgentId ? { agentId: requestAgentId } : {}),
            ...issued,
            ...selector,
          },
          { signal: readSignal },
        ),
    }).then((response) => {
      if (signal?.aborted || !isCurrent()) {
        return undefined;
      }
      const result = attachHistoryActivity(response);
      const raw = result.messages ?? [];
      const rawPacket = prepareChatHistoryPacket(
        raw,
        resolveChatHistoryPagination(result),
        result.newerCursor,
      );
      if (
        (issued.limit > CHAT_HISTORY_REQUEST_LIMIT ||
          issued.maxBytes > CHAT_HISTORY_REQUEST_MAX_BYTES) &&
        ((!rawPacket.boundedPacket &&
          raw.some((message) => !nativeHistoryMessageSourceId(message))) ||
          rawPacket.sources.length > issued.limit ||
          new TextEncoder().encode(JSON.stringify(raw)).byteLength > issued.maxBytes)
      ) {
        // An actual unkeyed/mixed broad reply cannot reopen interior cuts. Drop
        // its body and receipts before rereading this exact cursor under small bounds.
        return undefined;
      }
      const messages = visibleChatHistoryMessages(result.messages);
      const packet =
        messages.length === raw.length
          ? rawPacket
          : prepareChatHistoryPacket(
              messages,
              resolveChatHistoryPagination(result),
              result.newerCursor,
            );
      // Filtering cannot turn a larger raw response into a certified small packet.
      packet.boundedPacket = rawPacket.boundedPacket;
      return { ...result, messages, packet, requestBudget: issued, smallOnly };
    });
    if (signal?.aborted || !isCurrent()) {
      return {};
    }
    if (accepted) {
      return accepted;
    }
    budget = undefined;
    smallOnly = true;
  }
}

export type ChatHistoryPacketOwner = {
  controller: AbortController;
  direction?: "older" | "newer";
  page: StagedOlderHistoryPage | null;
  load: Promise<void> | null;
  capacityNotice?: string;
};

export type ChatHistoryPacketOperation = {
  state: ChatPageHost;
  paneId: string;
  direction: "older" | "newer";
  readerIntent: boolean;
  signal: AbortSignal;
  owner: ChatHistoryPacketOwner;
  read: NonNullable<ReturnType<typeof createChatHistoryPageRead>>;
  staged: StagedOlderHistoryPage | null;
  sessionId: string;
  root: string | false | undefined;
  edge: () => string | false | undefined;
  history: { loadingOlder: boolean };
  ownsIntent: () => boolean;
  isOwnerCurrent: () => boolean;
  settleForegroundRead: () => boolean;
  replaceOwner: () => void;
  recordFailure: (error: unknown) => void;
};

/** One captured foreground claim owns this on-demand packet operation. */
export async function loadPreparedChatHistoryPackets(
  operation: ChatHistoryPacketOperation,
): Promise<boolean> {
  const {
    state,
    paneId,
    direction,
    readerIntent,
    signal,
    owner,
    read,
    sessionId,
    ownsIntent,
    settleForegroundRead,
    recordFailure,
  } = operation;
  let { staged } = operation;
  operation.staged = null;
  const packets: StagedOlderHistoryPage[] = [];
  let overflow: StagedOlderHistoryPage | null = null;
  let failure: unknown;
  let capacityBlocked = false;
  let coverageAdvanced = false;
  let sparse = 0;
  let smallOnly = false;
  let adaptiveStop = false;
  const large = (page: StagedOlderHistoryPage) =>
    !page.result.packet?.boundedPacket &&
    ((page.result.requestBudget?.limit ?? 0) > CHAT_HISTORY_REQUEST_LIMIT ||
      (page.result.requestBudget?.maxBytes ?? 0) > CHAT_HISTORY_REQUEST_MAX_BYTES);
  try {
    let selector = chatHistoryPageSelector(state, direction);
    if (!selector || (!readerIntent && direction !== "older" && "messageId" in selector)) {
      return false;
    }
    // A trimmed boot edge may reopen once before its one small fill; reader
    // pagination alone owns adaptive envelopes and speculative continuation.
    const bootBoundary = !readerIntent && "messageId" in selector;
    const packetLimit = readerIntent ? MAX_RESIDENT_SEGMENTS : bootBoundary ? 2 : 1;
    let budget =
      readerIntent && !staged && "cursor" in selector
        ? readChatHistoryRequestBudget(state, prepareChatHistoryPages(state, [], direction))
        : undefined;
    for (let packet = 0; packet < packetLimit; packet++) {
      const requestedCursor: string = "cursor" in selector ? selector.cursor : "";
      const boundary =
        "messageId" in selector
          ? nativeHistoryMessageSourceIdentity(
              chatHistoryWindowBoundary(state.chatMessages, state.chatHistoryPagination, direction),
            )
          : null;
      if (!staged && direction === "older" && packets.length === 0) {
        operation.history.loadingOlder = true;
      }
      const limit = staged?.limit ?? ("limit" in selector ? selector.limit : undefined);
      let result = staged?.result ?? (await read.read(selector, signal, budget));
      staged = null;
      if (!settleForegroundRead()) {
        return false;
      }
      if (!result) {
        throw new Error(t("chat.thread.earlierInterrupted"));
      }
      smallOnly ||= result.smallOnly === true;
      if (requiresChatHistoryReload(result, sessionId, boundary)) {
        operation.replaceOwner();
        try {
          await reloadChatHistoryWindow(state);
        } catch (error) {
          // Our own reload retires the packet owner/version. Its failure
          // still belongs to the current reader intent.
          if (ownsIntent() && !signal.aborted) {
            recordFailure(error);
          }
          return false;
        }
        return true;
      }
      const next = resolveChatHistoryPagination(result, state.chatHistoryPagination.totalMessages);
      if (boundary) {
        reopenChatHistoryBoundary(state, boundary, next, direction);
        coverageAdvanced = true;
        operation.root = operation.edge();
        if (
          ++sparse >= (readerIntent ? 3 : 2) ||
          !(direction === "older" ? next.hasMore : next.hasNewer)
        ) {
          break;
        }
        selector = chatHistoryPageSelector(state, direction);
        if (!selector) {
          break;
        }
        budget =
          readerIntent && !smallOnly && "cursor" in selector
            ? readChatHistoryRequestBudget(state, prepareChatHistoryPages(state, [], direction))
            : undefined;
        continue;
      }
      const cursor = direction === "older" ? next.hasMore && next.olderCursor : next.newerCursor;
      if (cursor === requestedCursor) {
        throw new Error("History returned the same boundary. Reload the session to retry.");
      }
      let page: StagedOlderHistoryPage | null = {
        claim: read.claim,
        requestedCursor,
        result,
        ...(limit ? { limit } : {}),
      };
      let results = [...packets.map((entry) => entry.result), result];
      let prepared: ReturnType<typeof prepareChatHistoryPages> | undefined =
        prepareChatHistoryPages(state, results, direction);
      if (!prepared.fits) {
        // Async continuations can retain loop-local bindings after continue.
        // Release the rejected merged array before any narrower await.
        prepared = undefined;
        if (large(page)) {
          // Reader/pin custody can change during the reply. Refit the accepted
          // prefix; only a strictly smaller numeric envelope crosses the await.
          const issued = page.result.requestBudget;
          const narrower: ChatHistoryRequestBudget | undefined =
            readerIntent && !smallOnly
              ? readChatHistoryRequestBudget(
                  state,
                  prepareChatHistoryPages(
                    state,
                    packets.map((entry) => entry.result),
                    direction,
                  ),
                )
              : undefined;
          budget =
            issued &&
            narrower &&
            narrower.limit <= issued.limit &&
            narrower.maxBytes <= issued.maxBytes &&
            (narrower.limit < issued.limit || narrower.maxBytes < issued.maxBytes)
              ? narrower
              : undefined;
          smallOnly ||= !budget;
          selector = { cursor: requestedCursor };
          result = undefined;
          page = null;
          results = [];
          continue;
        }
        if (!packets.length && !limit) {
          // Discard this body before awaiting a narrower read from the same
          // authoritative edge; rejected replies never certify coverage.
          selector = { cursor: requestedCursor, limit: 1 };
          result = undefined;
          page = null;
          results = [];
          continue;
        }
        overflow = page;
        if (!packets.length) {
          capacityBlocked = true;
          failure = new Error(t("chat.thread.historyCapacity"));
        }
        break;
      }
      packets.push(page);
      const visible = hasVisibleOlderHistoryPage(state, paneId, result.messages ?? []);
      if (!visible && ++sparse >= (readerIntent ? 3 : 1)) {
        break;
      }
      if (!cursor) {
        break;
      }
      selector = { cursor };
      const adaptiveResponse = budget !== undefined && !limit;
      // Reuse this fit's facts synchronously; only numeric bounds cross the
      // next await. Changed live/reader custody is checked again on arrival.
      budget =
        readerIntent && !smallOnly ? readChatHistoryRequestBudget(state, prepared) : undefined;
      prepared = undefined;
      if (visible && adaptiveResponse && !smallOnly && !budget) {
        // No further adaptive envelope is available for this visible action.
        // Commit now; a small overflow would fragment the next reader action.
        adaptiveStop = true;
        break;
      }
    }
  } catch (error) {
    if (!settleForegroundRead()) {
      return false;
    }
    failure = error;
  }
  if (!settleForegroundRead()) {
    return false;
  }
  // Reader/live publication may have changed capacity during a later reply.
  // Keep a fitting contiguous prefix. Only an original small packet may wait
  // in the staged slot; discarded broad bodies never advance an opaque edge.
  const { acceptedCount, change: admitted } = admitChatHistoryPagePrefix(
    state,
    packets.map((page) => page.result),
    direction,
  );
  while (packets.length > acceptedCount) {
    const rejected = packets.pop()!;
    overflow = large(rejected) ? null : rejected;
    if (!packets.length && !overflow) {
      capacityBlocked = true;
      failure = new Error(t("chat.thread.historyCapacity"));
    }
  }
  // Exhausting bounded retries without admission or a reopened edge still
  // needs a visible outcome, even when every broad body was discarded.
  if (!packets.length && !failure && (overflow || !coverageAdvanced)) {
    capacityBlocked = true;
    failure = new Error(t("chat.thread.historyCapacity"));
  }
  owner.direction = direction;
  owner.page = overflow;
  if (admitted) {
    if (owner.capacityNotice && state.lastError === owner.capacityNotice) {
      state.lastError = null;
    }
    delete owner.capacityNotice;
    scheduleChatScroll(state, false);
  }
  if (failure) {
    recordFailure(failure);
    if (capacityBlocked && direction === "newer") {
      owner.capacityNotice = state.lastError ?? undefined;
    }
  } else if (admitted && readerIntent && !overflow && !adaptiveStop) {
    stageNextHistoryPage(operation);
  }
  return Boolean(admitted || (coverageAdvanced && !failure));
}
function stageNextHistoryPage(operation: ChatHistoryPacketOperation): void {
  const { state, direction, owner } = operation;
  if (!operation.isOwnerCurrent() || owner.page || owner.load) {
    return;
  }
  const pagination = state.chatHistoryPagination;
  const cursor =
    direction === "older" ? pagination.hasMore && pagination.olderCursor : pagination.newerCursor;
  if (!cursor) {
    return;
  }
  const read = createChatHistoryPageRead(state, true);
  if (!read) {
    return;
  }
  owner.direction = direction;
  owner.load = (async () => {
    try {
      const result = await read.read({ cursor }, owner.controller.signal);
      if (result && operation.isOwnerCurrent() && read.isCurrent()) {
        owner.page = { claim: read.claim, requestedCursor: cursor, result };
      }
    } catch {
      // A speculative failure is silent; a foreground chain reports its own.
    } finally {
      if (operation.isOwnerCurrent()) {
        owner.load = null;
      }
    }
  })();
}
