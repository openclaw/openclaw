import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import { scopedAgentIdForSession } from "../../lib/sessions/navigation.ts";
import { CHAT_HISTORY_TOOL_RESULT_MAX_CHARS } from "./chat-history-request-params.ts";
import { captureOlderHistoryClaim, chatHistoryOlderSelector } from "./chat-history-request.ts";
import { retryChatHistoryRead } from "./chat-history-retry.ts";
import { attachHistoryActivity, type ChatHistoryResult } from "./chat-history-snapshot.ts";
import { acceptsHistoryResult, beginHistoryRequest } from "./chat-history-state.ts";
import type { ChatState } from "./chat-state-contract.ts";

type OlderHistorySelector = NonNullable<ReturnType<typeof chatHistoryOlderSelector>>;

// Keep startup small, then amortize older-history reads and prepend work across
// larger pages. The Gateway owns the response byte and single-message limits.
export const CHAT_HISTORY_OLDER_PAGE_LIMIT = 1000;
const CHAT_HISTORY_OLDER_PAGE_MAX_BYTES = 3 * 1024 * 1024;

export async function requestOlderChatHistoryPage(
  client: GatewayBrowserClient,
  sessionKey: string,
  requestAgentId: string | undefined,
  selector: OlderHistorySelector,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<ChatHistoryResult> {
  const result = attachHistoryActivity(
    await retryChatHistoryRead({
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
            limit: "messageId" in selector ? 1 : CHAT_HISTORY_OLDER_PAGE_LIMIT,
            maxBytes: CHAT_HISTORY_OLDER_PAGE_MAX_BYTES,
            ...selector,
          },
          { signal: readSignal },
        ),
    }),
  );
  return {
    ...result,
    messages: visibleChatHistoryMessages(result.messages),
  };
}

export async function loadOlderChatHistoryPage(
  state: ChatState,
  selector: OlderHistorySelector,
  signal?: AbortSignal,
): Promise<ChatHistoryResult | undefined> {
  if (!state.client || !state.connected) {
    return undefined;
  }
  const client = state.client;
  const sessionKey = state.sessionKey;
  const requestAgentId = scopedAgentIdForSession(state, sessionKey);
  const ownership = beginHistoryRequest(
    state,
    client,
    state.connectionEpoch,
    sessionKey,
    requestAgentId,
  );
  const result = await requestOlderChatHistoryPage(
    client,
    sessionKey,
    requestAgentId,
    selector,
    () => acceptsHistoryResult(state, ownership),
    signal,
  );
  if (signal?.aborted || !acceptsHistoryResult(state, ownership)) {
    return undefined;
  }
  return result;
}

type StagedOlderHistoryPage = NonNullable<Awaited<ReturnType<typeof fetchStagedOlderHistoryPage>>>;

// The staged prefetch deliberately skips beginHistoryRequest: request
// ownership is last-writer-wins, so a background fetch bumping the version
// could invalidate a concurrent tail load's apply. The claim below carries the
// same facts and the pane validates it at consume time instead.
async function fetchStagedOlderHistoryPage(state: ChatState, cursor: string, signal?: AbortSignal) {
  if (!state.client || !state.connected) {
    return undefined;
  }
  const client = state.client;
  const claim = captureOlderHistoryClaim(state, client);
  const result = await requestOlderChatHistoryPage(
    client,
    claim.sessionKey,
    claim.agentId,
    { cursor },
    () => acceptsHistoryResult(state, claim),
    signal,
  );
  return { claim, requestedCursor: cursor, result };
}

/** A staged page is valid only for the exact connection, session, and the
 * pagination cursor it was fetched at; any drift means the reactive path must
 * refetch (tail reloads may replace the window, resets reuse session keys). */
function isStagedOlderHistoryPageCurrent(
  state: ChatState,
  staged: StagedOlderHistoryPage,
): boolean {
  const claim = staged.claim;
  const pagination = state.chatHistoryPagination;
  return (
    acceptsHistoryResult(state, claim) &&
    pagination.hasMore &&
    pagination.olderCursor === staged.requestedCursor
  );
}

export type StagedOlderRead = {
  controller: AbortController;
  page: StagedOlderHistoryPage | null;
  load: Promise<void> | null;
};

export function stageNextOlderPage(
  state: ChatState,
  owner: StagedOlderRead,
  current: () => boolean,
): void {
  if (owner.page || owner.load) {
    return;
  }
  const pagination = state.chatHistoryPagination;
  const cursor = pagination.hasMore && pagination.olderCursor;
  if (!cursor) {
    return;
  }
  // One async closure keeps the bookkeeping inside the awaited promise, so a
  // joiner resuming from this load always observes the staged page and the
  // cleared in-flight slot together. The owner guard keeps a stale
  // finally (fetch outliving a viewport reset) off a successor's slot.
  owner.load = (async () => {
    try {
      const staged = await fetchStagedOlderHistoryPage(state, cursor, owner.controller.signal);
      if (staged && current()) {
        owner.page = staged;
      }
    } catch {
      // Prefetch is best-effort: the reactive path owns retries, error
      // surfacing, and the blocked-until-intent machinery.
    } finally {
      if (current()) {
        owner.load = null;
      }
    }
  })();
}

// Single-consume: an invalid staged page is discarded rather than retried so
// stale prefetches can never shadow the reactive path's fresh cursor.
function takeStagedOlderPage(state: ChatState, owner: StagedOlderRead): ChatHistoryResult | null {
  const staged = owner.page;
  if (!staged) {
    return null;
  }
  owner.page = null;
  return isStagedOlderHistoryPageCurrent(state, staged) ? staged.result : null;
}

export async function readViewportOlderPage(
  state: ChatState,
  staged: StagedOlderRead,
  signal: AbortSignal,
  isCurrent: () => boolean,
  loading: () => void,
  boundaryIdentity: () => string | null | undefined,
) {
  let result = takeStagedOlderPage(state, staged);
  if (!result && staged.load) {
    loading();
    await staged.load;
    if (!isCurrent()) {
      return undefined;
    }
    result = takeStagedOlderPage(state, staged);
  }
  const pagination = state.chatHistoryPagination;
  if (!pagination.hasMore) {
    return undefined;
  }
  const expectedSessionId = state.currentSessionId?.trim() ?? "";
  const selector = chatHistoryOlderSelector(state);
  if (!selector) {
    return undefined;
  }
  const boundary = "messageId" in selector ? boundaryIdentity() : undefined;
  const requestedCursor = pagination.olderCursor;
  if (!result) {
    loading();
    result = (await loadOlderChatHistoryPage(state, selector, signal)) ?? null;
  }
  if (!isCurrent()) {
    return undefined;
  }

  return { result, pagination, expectedSessionId, boundary, requestedCursor };
}
