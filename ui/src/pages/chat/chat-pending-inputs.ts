import {
  CHAT_INPUT_RECEIPT_MAX_RUN_IDS,
  CHAT_INPUT_RUN_ID_MAX_CHARS,
} from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { findChatSubmissionMessage } from "../../lib/chat/history-message-identity.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import type {
  ChatPendingInputAction,
  ChatPendingInputView,
  PendingInputRequest,
} from "./chat-pending-inputs.types.ts";
import { removeQueuedMessage } from "./chat-queue.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import type { ChatState } from "./chat-state-contract.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reconcileChatInputCustody,
} from "./history-merge.ts";

export type { PendingSteer } from "./chat-pending-input-display.ts";
export { buildPendingInputQueueItems } from "./chat-pending-input-presentation.ts";

export function isPendingInputDismissHidden(view: ChatPendingInputView, id: string): boolean {
  return Boolean(view.dismissing?.has(id) || view.dismissed?.has(id));
}

export function reconcileQueuedInputs(
  queued: ChatPendingInputsPage["items"],
  page: ChatPendingInputsPage,
  receipts?: ChatInputReceipts,
  queriedRunIds: readonly string[] = [],
): ChatPendingInputsPage["items"] {
  if (page.queuedCount === 0) {
    return [];
  }
  const completePage = page.nextBefore === undefined && page.items.length === page.total;
  const observed = new Map(receipts?.map((receipt) => [receipt.runId, receipt]));
  const queried = new Set(receipts === undefined ? [] : queriedRunIds);
  const current = new Map((completePage ? [] : queued).map((input) => [input.id, input]));
  for (const input of page.items) {
    if (input.queued) {
      current.set(input.id, input);
    } else {
      current.delete(input.id);
    }
  }
  // Ordinary consumption deletes custody. An exact queried absence retires its
  // queue projection even when the transcript has advanced beyond that message.
  return [...current.values()].filter((input) => {
    const receipt = input.runId ? observed.get(input.runId) : undefined;
    return receipt
      ? receipt.state === "pending" && receipt.queued
      : !input.runId || !queried.has(input.runId);
  });
}

export function getChatPendingInputs(state: ChatState): ChatPendingInputView | undefined {
  const view = state.chatPendingInputs;
  return view?.sessionKey === state.sessionKey &&
    view.sessionId === (state.currentSessionId ?? null) &&
    view.agentId === resolveUiSelectedSessionAgentId(state)
    ? view
    : undefined;
}

export function clearChatPendingInputs(state: ChatState): void {
  state.chatPendingInputs = undefined;
}

function collectChatInputRunIds(state: ChatState): string[] {
  const projection = getChatSessionProjection(
    state,
    readChatSessionProjectionScope(state, { agentId: resolveUiSelectedSessionAgentId(state) }),
  );
  const runIds = [
    ...(getChatPendingInputs(state)?.queuedInputs.map((input) => input.runId) ?? []),
    ...projection.entries
      .filter((entry) => entry.pending && entry.identity?.role === "user")
      .map((entry) => entry.pendingRunId),
    ...state.chatQueue.filter((item) => (item.sendAttempts ?? 0) > 0).map((item) => item.sendRunId),
  ];
  const current = new Set(
    runIds.filter((id): id is string => Boolean(id && id.length <= CHAT_INPUT_RUN_ID_MAX_CHARS)),
  );
  const retained = getChatPendingInputs(state)?.receiptRunIds.filter((id) => current.delete(id));
  return [...(retained ?? []), ...current];
}

export function readChatInputRunIds(state: ChatState): string[] {
  return collectChatInputRunIds(state).slice(0, CHAT_INPUT_RECEIPT_MAX_RUN_IDS).toSorted();
}

export function rotateInputReceipts(
  state: ChatState,
  view: ChatPendingInputView,
  queriedRunIds: readonly string[] = [],
): void {
  const observed = new Set(queriedRunIds);
  // Rotate across server, transcript, and browser custody without starving any source.
  view.receiptRunIds = collectChatInputRunIds(state).toSorted(
    (left, right) => Number(observed.has(left)) - Number(observed.has(right)),
  );
}

export function reconcilePendingInputPage(
  state: ChatState,
  page: ChatPendingInputsPage | undefined,
  receipts?: ChatInputReceipts,
): ChatPendingInputsPage {
  const { page: displayPage, acceptedRunIds } = reconcileChatInputCustody(state, page, receipts);
  const settled = new Set([
    ...(receipts ?? [])
      .filter(
        (receipt) =>
          receipt.state === "consumed" || (receipt.state === "pending" && receipt.cancelled),
      )
      .map((receipt) => receipt.runId),
    ...displayPage.items.filter((input) => input.state === "cancelled").map((input) => input.runId),
  ]);
  // Any positive custody receipt transfers retry ownership to the Gateway.
  for (const item of state.chatQueue) {
    const canonical = findChatSubmissionMessage(state.chatMessages, item.sendRunId, true);
    if (
      item.sendRunId &&
      (acceptedRunIds.has(item.sendRunId) ||
        settled.has(item.sendRunId) ||
        (canonical && (canonical.id !== null || canonical.sequence !== null))) &&
      (!item.sessionId || item.sessionId === state.currentSessionId)
    ) {
      removeQueuedMessage(state, item.id);
    }
  }
  return displayPage;
}

function ownsPendingInputRequest(
  state: ChatState,
  view: ChatPendingInputView,
  request: PendingInputRequest,
): boolean {
  return (
    getChatPendingInputs(state) === view &&
    view.request === request &&
    state.client === request.client &&
    state.connected &&
    state.connectionEpoch === request.connectionEpoch
  );
}

export function applyChatPendingInputs(
  state: ChatState,
  page: ChatPendingInputsPage | undefined,
  options: { receipts?: ChatInputReceipts; queriedRunIds?: readonly string[] } = {},
): void {
  const displayPage = reconcilePendingInputPage(state, page, options.receipts);
  let view = getChatPendingInputs(state);
  const queuedInputs = reconcileQueuedInputs(
    view?.queuedInputs ?? [],
    displayPage,
    options.receipts,
    options.queriedRunIds,
  );
  if (!view) {
    view = {
      sessionKey: state.sessionKey,
      sessionId: state.currentSessionId ?? null,
      agentId: resolveUiSelectedSessionAgentId(state),
      page: displayPage,
      queuedInputs,
      receiptRunIds: [],
      queuedCount: displayPage.queuedCount ?? 0,
      queueBefore: displayPage.nextBefore,
      get loading() {
        return this.request?.kind === "navigation";
      },
    };
    state.chatPendingInputs = view;
  } else {
    view.queuedInputs = queuedInputs;
    view.queuedCount = displayPage.queuedCount ?? 0;
    view.queueBefore = displayPage.nextBefore;
    if (view.request && !ownsPendingInputRequest(state, view, view.request)) {
      view.request = undefined;
    }
    if (view.before === undefined) {
      view.page = displayPage;
      view.error = undefined;
    }
    // Latest custody updates ownership immediately, but cannot take over browsing.
    if (view.before !== undefined && !view.request) {
      void requestPendingInputPage(state, view.before, "refresh");
    }
  }
  rotateInputReceipts(state, view, options.queriedRunIds);
  if (
    !view.request &&
    view.queuedInputs.length < view.queuedCount &&
    view.queueBefore !== undefined
  ) {
    void requestPendingInputPage(state, view.queueBefore, "discovery");
  }
  chatRunPresentation(state).publish();
}

export async function requestPendingInputPage(
  state: ChatState,
  before: number | undefined,
  kind: PendingInputRequest["kind"],
): Promise<void> {
  const view = getChatPendingInputs(state);
  const client = state.client;
  if (!view || !client || !state.connected) {
    return;
  }
  if (
    view.request &&
    ownsPendingInputRequest(state, view, view.request) &&
    (kind !== "navigation" || view.request.kind === "navigation")
  ) {
    return;
  }
  const request = { before, kind, client, connectionEpoch: state.connectionEpoch };
  view.request = request;
  view.error = undefined;
  if (kind === "navigation") {
    chatRunPresentation(state).publish();
  }
  const current = () => ownsPendingInputRequest(state, view, request);
  try {
    const { fetchPendingInputPage } = await import("./chat-pending-inputs.runtime.ts");
    await fetchPendingInputPage(state, view, request, current);
  } catch (error) {
    if (current()) {
      view.error = formatUiError(error);
    }
  } finally {
    if (view.request === request) {
      view.request = undefined;
      if (getChatPendingInputs(state) === view) {
        chatRunPresentation(state).publish();
      }
    }
  }
}

export function loadChatPendingInputs(state: ChatState, before?: number): Promise<void> {
  return requestPendingInputPage(state, before, "navigation");
}

export async function mutateChatPendingInput(
  state: ChatState,
  action: ChatPendingInputAction,
): Promise<void> {
  const view = getChatPendingInputs(state);
  const client = state.client;
  const sessionId = view?.sessionId;
  if (!view || !sessionId || !client || !state.connected) {
    return;
  }
  const connectionIsCurrent = captureChatConnectionOwner(state, false);
  const current = () => connectionIsCurrent() && getChatPendingInputs(state) === view;
  // Keep dismissal immediate while its mutation implementation loads on demand.
  if (action.kind === "dismiss") {
    (view.dismissing ??= new Map()).set(action.inputId, current);
    view.error = undefined;
    chatRunPresentation(state).publish();
  }
  try {
    const { executePendingInputAction } = await import("./chat-pending-inputs.runtime.ts");
    if (current()) {
      await executePendingInputAction(
        { state, view, client, sessionId, current, connectionIsCurrent },
        action,
      );
    }
  } catch (error) {
    if (!current()) {
      return;
    }
    if (action.kind === "steer") {
      // A refused Send now is not a user-facing error: the steer stays queued and
      // still reaches the next model turn. Refresh so its row shows current state.
      void requestPendingInputPage(state, view.before, "refresh");
    } else {
      view.error = formatUiError(error);
    }
  } finally {
    if (getChatPendingInputs(state) === view) {
      if (action.kind === "dismiss" && view.dismissing?.get(action.inputId) === current) {
        view.dismissing.delete(action.inputId);
      }
      chatRunPresentation(state).publish();
    }
  }
}
