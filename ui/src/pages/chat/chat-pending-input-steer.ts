import type { ChatSteerResult } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { formatUiError } from "../../lib/format-error.ts";
import { chatHistoryRequests, setChatError } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { getChatPendingInputs } from "./chat-pending-inputs.ts";
import { chatProviderReviewRow } from "./chat-provider-review.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

export async function steerPendingQueuedChatInput(
  state: ChatPageHost,
  id: string,
): Promise<boolean> {
  if (!id.startsWith("pending-input:")) {
    return false;
  }
  const view = getChatPendingInputs(state);
  const input = view?.queuedInputs.find(
    (item) => `pending-input:${item.id}` === id && item.queued && item.state === "queued",
  );
  const client = state.client;
  if (
    !view?.sessionId ||
    !input?.runId ||
    !client ||
    !state.connected ||
    view.steeringRunIds.has(input.runId) ||
    chatProviderReviewRow(state)?.providerReview
  ) {
    return true;
  }
  const epoch = state.connectionEpoch;
  const sessions = state.sessions;
  const requests = chatHistoryRequests(state);
  const subscriptionGeneration = requests.subscriptionGeneration;
  const current = () =>
    getChatPendingInputs(state) === view &&
    state.client === client &&
    state.connected &&
    state.connectionEpoch === epoch &&
    state.sessions === sessions &&
    requests.subscriptionGeneration === subscriptionGeneration;
  const version = ++view.steerRequestVersion;
  if (
    view.steerError &&
    requests.chatErrorVersion === view.steerError.version &&
    state.chatError === view.steerError.message &&
    state.lastError === view.steerError.message
  ) {
    setChatError(state, null);
  }
  view.steerError = undefined;
  const errorVersion = requests.chatErrorVersion;
  const previousError = state.chatError;
  const previousLastError = state.lastError;
  const publishError = (error: string) => {
    if (
      current() &&
      view.steerRequestVersion === version &&
      requests.chatErrorVersion === errorVersion &&
      state.chatError === previousError &&
      state.lastError === previousLastError &&
      view.queuedInputs.some((item) => item.runId === input.runId && item.queued)
    ) {
      const message = formatUiError(error);
      const publishedVersion = setChatError(state, message, true);
      view.steerError = { message, version: publishedVersion };
    }
  };
  view.steeringRunIds.add(input.runId);
  state.requestUpdate?.();
  let result: ChatSteerResult;
  try {
    result = await client.request<ChatSteerResult>("chat.steer", {
      sessionKey: view.sessionKey,
      agentId: view.agentId,
      sessionId: view.sessionId,
      runId: input.runId,
    });
  } catch (error) {
    publishError(formatUiError(error));
    return true;
  } finally {
    // Busy belongs to the control RPC, not the following custody read. A retry
    // sends the same admitted identity and relies on server idempotency.
    view.steeringRunIds.delete(input.runId);
    if (current()) {
      state.requestUpdate?.();
    }
  }
  if (current()) {
    // Custody reconciliation must not reset the draft being recalled or clear
    // another action's error while this control request was awaiting its ACK.
    await loadChatHistory(state, { supersedeInFlight: true, preserveComposerState: true });
    if (result.status === "queued") {
      publishError(result.reason);
    }
  }
  return true;
}
