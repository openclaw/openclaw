import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
  ChatPendingInputsDismissResult,
  ChatSteerNowResult,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
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
import { describePendingSteerWait } from "./chat-send-presentation.ts";
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
  if (action.kind === "steer") {
    const result = await client.request<ChatSteerNowResult>("chat.steerNow", {
      ...scope,
      sessionId,
      runId: action.runId,
    });
    if (current()) {
      await requestPendingInputPage(state, view.before, "refresh");
      if (current() && (result.status === "blocked" || result.status === "unavailable")) {
        view.error = describePendingSteerWait(result.tools);
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
