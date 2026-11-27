import type { RetainedChatSubmission } from "../../app/chat-submissions.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { findChatSubmissionMessage } from "../../lib/chat/history-message-identity.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";
import { chatOutboxDeliveryKey } from "../../lib/chat/outbox-store.ts";
import { visibleSessionMatches } from "../../lib/sessions/navigation.ts";
import { getChatPendingInputs } from "./chat-pending-inputs.ts";
import {
  readDeliveredQueuedChatSendForRun,
  readQueuedMessageById,
  removeDeliveredQueuedChatSendForRun,
  updateQueuedMessage,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import {
  admitChatSubmission,
  retireChatSubmissionDisplay,
  shouldDisplayChatSubmission,
} from "./history-merge.ts";
import {
  captureOutboxPayloadOwner,
  failOutboxPayload,
  prepareOutboxPayload,
} from "./outbox-payloads.ts";
import { appendChatMessageToCache, readChatMessagesFromCache } from "./session-message-cache.ts";
import { persistedSteerTargetRunId } from "./stream-causal-boundary.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

function preserveDeliveredUserTurn(
  state: ChatHost,
  submission: RetainedChatSubmission | undefined,
): void {
  if (submission?.kind !== "delivered" || !submission.pending) {
    return;
  }
  const { sessionKey, agentId, message } = submission;
  if (visibleSessionMatches(state, sessionKey, agentId)) {
    if (
      !submission.sessionId ||
      !state.currentSessionId ||
      submission.sessionId === state.currentSessionId
    ) {
      admitChatSubmission(state, getChatPendingInputs(state)?.page.items, submission);
    }
    return;
  }
  if (state.chatMessagesBySession) {
    const target = { sessionKey, agentId };
    const cached = readChatMessagesFromCache(state.chatMessagesBySession, state, target);
    if (
      shouldDisplayChatSubmission(
        submission,
        findChatSubmissionMessage(cached, submission.pendingRunId, true),
      )
    ) {
      appendChatMessageToCache(state.chatMessagesBySession, state, target, message);
    }
  }
}

type DeliveredTurnRetirement = "retired" | "retained" | "stale";

/** Preserve local display bytes until canonical consumption retires the submission. */
export function retireDeliveredQueuedUserTurn(
  host: ChatHost,
  runId: string | undefined,
  scope: StoredChatOutboxScope,
  options?: { retainUntilConsumed?: boolean; inputConsumed?: boolean },
): DeliveredTurnRetirement | Promise<DeliveredTurnRetirement> {
  const client = host.client;
  const owner = client ?? host;
  const submissions = host.chatSubmissions;
  const deliveryKey = chatOutboxDeliveryKey(host, scope, runId);
  const stored = readDeliveredQueuedChatSendForRun(host, runId, scope);
  if (options?.inputConsumed && runId) {
    const remembered = submissions.readDelivered(deliveryKey, owner);
    if (remembered && !persistedSteerTargetRunId(remembered.message)) {
      remembered.pending = false;
    }
    if (
      visibleSessionMatches(host, scope.sessionKey, scope.agentId) &&
      (!stored?.sessionId || stored.sessionId === host.currentSessionId)
    ) {
      retireChatSubmissionDisplay(host, new Set([runId]), { awaitTranscriptReceipt: true });
    }
    return !stored || removeDeliveredQueuedChatSendForRun(host, runId, scope)
      ? "retired"
      : "retained";
  }
  if (!stored) {
    preserveDeliveredUserTurn(host, submissions.readDelivered(deliveryKey, owner));
    return "retired";
  }
  const connectionEpoch = host.connectionEpoch;
  const connected = host.connected;
  const payloadOwnerIsCurrent = captureOutboxPayloadOwner(host);
  const isCurrent = () =>
    host.connected === connected &&
    host.connectionEpoch === connectionEpoch &&
    payloadOwnerIsCurrent();
  const currentItem = () => readDeliveredQueuedChatSendForRun(host, runId, scope);
  const commit = (
    message: NonNullable<ReturnType<typeof buildLocalUserMessage>>,
  ): DeliveredTurnRetirement => {
    if (!isCurrent()) {
      return "stale";
    }
    const current = currentItem();
    if (!current) {
      preserveDeliveredUserTurn(host, submissions.readDelivered(deliveryKey, owner));
      // Consumption can retire the outbox during hydration. A replacement
      // attempt still owns the row; an absent row must not swallow chat.final.
      return readQueuedMessageById(host, stored.id) ? "stale" : "retired";
    }
    if (!sameQueuedDeliveryVersion(current, stored) || !stored.sendRunId) {
      return "stale";
    }
    // Every pane receives the terminal. Retain complete message bytes before
    // the first pane removes the outbox item and releases its Blob/preview URLs.
    const remembered = submissions.readDelivered(deliveryKey, owner);
    const submission = submissions.retain({
      kind: "delivered",
      deliveryKey,
      owner,
      sessionKey: stored.sessionKey ?? scope.sessionKey,
      agentId: stored.agentId,
      sessionId: stored.sessionId,
      pendingRunId: stored.sendRunId,
      message:
        remembered?.kind === "delivered" &&
        remembered.pending &&
        persistedSteerTargetRunId(remembered.message)
          ? remembered.message
          : message,
    });
    preserveDeliveredUserTurn(host, submission);
    const beforeRemoval = currentItem();
    if (!isCurrent() || !beforeRemoval || !sameQueuedDeliveryVersion(beforeRemoval, stored)) {
      return "stale";
    }
    return !options?.retainUntilConsumed && removeDeliveredQueuedChatSendForRun(host, runId, scope)
      ? "retired"
      : "retained";
  };
  const live = readQueuedMessageById(host, stored.id);
  const source =
    live &&
    live.attachmentPayload?.key === stored.attachmentPayload?.key &&
    live.attachments?.length === stored.attachments?.length
      ? live
      : stored;
  const buildMessage = (attachments: readonly ChatAttachment[] | undefined) =>
    buildLocalUserMessage(
      {
        ...stored,
        attachments,
        runId: stored.sendRunId,
      },
      "complete",
    );
  const message = buildMessage(source.attachments) ?? buildMessage(stored.attachments);
  if (
    message &&
    ((!stored.attachmentPayload && !stored.attachmentStorageError) ||
      (stored.attachments?.length ?? 0) > 0)
  ) {
    return commit(message);
  }
  return prepareOutboxPayload(host, stored, "handoff").then((result): DeliveredTurnRetirement => {
    if (!isCurrent()) {
      return "stale";
    }
    if (result.status === "ready") {
      const hydrated = buildMessage(result.update.attachments ?? stored.attachments);
      if (hydrated) {
        return commit(hydrated);
      }
    }
    const current = currentItem();
    if (!current) {
      return readQueuedMessageById(host, stored.id) ? "stale" : "retired";
    }
    if (!sameQueuedDeliveryVersion(current, stored)) {
      return "stale";
    }
    const reason = result.status === "failed" ? result.reason : "missing";
    // Keep the same key if local projection fails after delivery.
    updateQueuedMessage(host, stored.id, (item) =>
      failOutboxPayload(
        { ...item, sendState: item.sendState === "held" ? "held" : "failed" },
        reason,
      ),
    );
    return "retained";
  });
}
