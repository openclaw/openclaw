import type { ChatSteerResult } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { formatUiError } from "../../lib/format-error.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { getChatPendingInputs, loadChatPendingInputs } from "./chat-pending-inputs.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import type { ChatHost } from "./chat-send-contract.ts";

/** Gateway custody is controlled by identity, never by resending the display preview. */
export async function steerPendingQueuedChatInput(state: ChatHost, id: string): Promise<boolean> {
  if (!id.startsWith("pending-input:")) {
    return false;
  }
  const view = getChatPendingInputs(state);
  const input = view?.queuedInputs.find((item) => "pending-input:" + item.id === id && item.queued);
  const client = state.client;
  if (
    !view?.sessionId ||
    !input?.runId ||
    !client ||
    !state.connected ||
    view.steering?.has(input.runId)
  ) {
    return true;
  }
  const connectionIsCurrent = captureChatConnectionOwner(state);
  const current = () => connectionIsCurrent() && getChatPendingInputs(state) === view;
  view.steering = new Set([...(view.steering ?? []), input.runId]);
  view.error = undefined;
  chatRunPresentation(state).publish();
  let result: ChatSteerResult | undefined;
  try {
    result = await client.request<ChatSteerResult>("chat.steer", {
      sessionKey: view.sessionKey,
      agentId: view.agentId,
      sessionId: view.sessionId,
      runId: input.runId,
    });
  } catch (error) {
    if (current()) {
      view.error = formatUiError(error);
    }
  } finally {
    view.steering = new Set([...view.steering].filter((runId) => runId !== input.runId));
    if (current()) {
      chatRunPresentation(state).publish();
    }
  }
  if (result && current()) {
    // The existing custody reader preserves composer drafts and retained-page browsing.
    await loadChatPendingInputs(state, view.before);
    if (
      current() &&
      result.status === "queued" &&
      view.queuedInputs.some((item) => item.runId === input.runId)
    ) {
      view.error = result.reason;
      chatRunPresentation(state).publish();
    }
  }
  return true;
}
