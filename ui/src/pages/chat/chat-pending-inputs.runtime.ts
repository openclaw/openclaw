import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
  ChatPendingInputsDismissResult,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import {
  applyChatPendingInputs,
  clearChatPendingInputs,
  getChatPendingInputs,
  readChatInputRunIds,
  reconcilePendingInputPage,
  reconcileQueuedInputs,
  requestPendingInputPage,
  rotateInputReceipts,
} from "./chat-pending-inputs.ts";
import type {
  ChatPendingInputAction,
  ChatPendingInputView,
  PendingInputRequest,
} from "./chat-pending-inputs.types.ts";
import {
  readDeliveredQueuedChatSendForRun,
  removeDeliveredQueuedChatSendForRun,
} from "./chat-queue.ts";
import type { ChatState } from "./chat-state-contract.ts";

export async function executePendingInputAction(
  {
    state,
    view,
    client,
    sessionId,
    current,
    connectionIsCurrent,
  }: {
    state: ChatState;
    view: ChatPendingInputView;
    client: GatewayBrowserClient;
    sessionId: string;
    current: () => boolean;
    connectionIsCurrent: () => boolean;
  },
  action: ChatPendingInputAction,
): Promise<void> {
  const scope = { sessionKey: view.sessionKey, agentId: view.agentId };
  if (action.kind === "copy") {
    const result = await client.request<{ text: string | null }>("chat.pendingInputs.own", {
      ...scope,
      inputId: action.inputId,
    });
    if (current() && result.text !== null) {
      await copyToClipboard(result.text, current);
    }
    return;
  }
  if (action.kind === "steer") {
    await client.request("chat.steerNow", { ...scope, sessionId, runId: action.runId });
    // A refused steer stays queued; the refreshed row shows why (listing and
    // steering read the same controller state). If it changed in between, the
    // row still offers "Send now" and the user can retry.
    if (current()) {
      await requestPendingInputPage(state, view.before, "refresh");
    }
    return;
  }
  if (
    view.page.items.some((input) => input.id === action.inputId && input.endCause === "revoked")
  ) {
    const result = await client.request<{ pendingInputs: ChatPendingInputsPage }>(
      "chat.pendingInputs.own",
      { ...scope, inputIds: [action.inputId] },
    );
    if (current()) {
      view.dismissed = new Set([...(view.dismissed ?? []), action.inputId]);
      view.page = {
        ...view.page,
        items: view.page.items.filter((input) => input.id !== action.inputId),
      };
      if (view.ownOnly) {
        view.page = result.pendingInputs;
      }
    }
    return;
  }
  const result = await client.request<ChatPendingInputsDismissResult>(
    "chat.pendingInputs.dismiss",
    { ...scope, sessionId, inputIds: [action.inputId] },
  );
  // Route changes retain this connection's custody; a replacement Gateway owns its own copies.
  if (connectionIsCurrent()) {
    for (const runId of result.runIds) {
      const copy = readDeliveredQueuedChatSendForRun(state, runId, scope);
      if (copy && (!copy.sessionId || copy.sessionId === sessionId)) {
        removeDeliveredQueuedChatSendForRun(state, runId, scope);
      }
    }
  }
  if (current()) {
    view.dismissed = new Set([
      ...(view.dismissed ?? []),
      ...result.dismissedIds,
      ...result.missingIds,
    ]);
    void requestPendingInputPage(state, view.before, "refresh");
  }
}

export async function fetchPendingInputPage(
  state: ChatState,
  view: ChatPendingInputView,
  request: PendingInputRequest,
  current: () => boolean,
): Promise<void> {
  if (view.ownOnly) {
    const result = await request.client.request<{ pendingInputs: ChatPendingInputsPage }>(
      "chat.pendingInputs.own",
      { sessionKey: view.sessionKey, agentId: view.agentId, before: request.before },
    );
    if (current()) {
      view.page = result.pendingInputs;
      view.before = request.before;
    }
    return;
  }
  while (current()) {
    const inputRunIds = readChatInputRunIds(state);
    const result = await request.client.request<{
      sessionId?: string;
      pendingInputs?: ChatPendingInputsPage;
      inputReceipts?: ChatInputReceipts;
    }>("chat.history", {
      sessionKey: view.sessionKey,
      toolResultMaxChars: 2_000,
      agentId: view.agentId,
      limit: 20,
      ...(inputRunIds.length ? { inputRunIds } : {}),
      ...(request.before === undefined ? {} : { pendingBefore: request.before }),
    });
    if (!current() || result.sessionId !== view.sessionId) {
      return;
    }
    // An overlapping live update may leave this page briefly behind; the next
    // ordinary refresh catches it up without restarting navigation reads.
    const page = reconcilePendingInputPage(state, result.pendingInputs, result.inputReceipts);
    view.queuedInputs = reconcileQueuedInputs(
      view.queuedInputs,
      page,
      result.inputReceipts,
      inputRunIds,
    );
    view.queuedCount = page.queuedCount ?? view.queuedCount;
    rotateInputReceipts(state, view, inputRunIds);
    if (request.kind !== "discovery") {
      view.page = page;
      view.before = request.before;
    }
    if (request.kind === "discovery" || request.before === undefined) {
      view.queueBefore = page.nextBefore;
    }
    if (view.queuedInputs.length < view.queuedCount && view.queueBefore !== undefined) {
      request.kind = "discovery";
      request.before = view.queueBefore;
      continue;
    }
    return;
  }
}

export async function restoreOwnCancelledInputs(
  state: ChatState,
  current: () => boolean,
): Promise<void> {
  try {
    const result = await state.client!.request<{
      sessionId?: string;
      pendingInputs: ChatPendingInputsPage;
    }>("chat.pendingInputs.own", {
      sessionKey: state.sessionKey,
      agentId: resolveUiSelectedSessionAgentId(state),
    });
    if (!current()) {
      return;
    }
    if (result.sessionId) {
      state.currentSessionId = result.sessionId;
    }
    clearChatPendingInputs(state);
    applyChatPendingInputs(state, { ...result.pendingInputs, queuedCount: 0 });
    const view = getChatPendingInputs(state);
    if (view) {
      view.ownOnly = true;
    }
  } catch {
    // The history failure already owns presentation; an unavailable private queue adds no notice.
  }
}
