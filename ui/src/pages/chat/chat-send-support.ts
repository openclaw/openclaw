import type { SessionsListResult } from "../../api/types.ts";
import type { RetainedChatSubmission } from "../../app/chat-submissions.ts";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { parseSlashCommand } from "../../lib/chat/commands.ts";
import { findChatSubmissionMessage } from "../../lib/chat/history-message-identity.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";
import { chatOutboxDeliveryKey } from "../../lib/chat/outbox-store.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { visibleSessionMatches } from "../../lib/sessions/navigation.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { isExpiredIncognitoSession } from "./chat-history-state.ts";
import { getChatPendingInputs } from "./chat-pending-inputs.ts";
import { chatProviderReviewRow } from "./chat-provider-review.ts";
import {
  readDeliveredQueuedChatSendForRun,
  readQueuedMessageById,
  removeDeliveredQueuedChatSendForRun,
  updateQueuedMessage,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import type { ChatQueueAdmissionResult } from "./composer-queue-persistence.ts";
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

export const OFFLINE_QUEUE_STORAGE_ERROR =
  "Could not store this message for reconnect. Free browser storage or reconnect before sending.";

export function formatChatQueueAdmissionError(
  result: Exclude<ChatQueueAdmissionResult, "admitted">,
  editing: boolean,
): string {
  if (result === "source-changed") {
    return t("chat.queue.editSourceChanged");
  }
  if (result === "full") {
    return t("chat.queue.full");
  }
  return editing ? t("chat.queue.editStorageFailed") : OFFLINE_QUEUE_STORAGE_ERROR;
}

export function isChatResetCommand(text: string) {
  const parsed = parseSlashCommand(text);
  return (
    parsed?.command.key === "new" ||
    (parsed?.command.key === "reset" && !/^soft(?:\s|$)/i.test(parsed.args))
  );
}

/** Commands and Goals have their own terminal receipts; chat needs input consumption. */
export function requiresChatInputConsumption(item: ChatQueueItem): boolean {
  return !item.intent && !item.localCommandName && !item.text.trimStart().startsWith("/");
}

/** Local queue admission does not require the initial turn to have settled. */
export function chatSendAdmissionHoldReason(
  host: ChatHost,
  sessionKey: string,
  agentId?: string,
): string | null {
  if (sessionKey === host.sessionKey && host.isRouteSessionPending?.()) {
    return t("chat.thread.loading");
  }
  if (isExpiredIncognitoSession(host, sessionKey)) {
    return t("chat.incognitoExpiredTitle");
  }
  const sendDisabledReason = chatProviderReviewRow(host, sessionKey, agentId)?.sendDisabledReason;
  if (sendDisabledReason) {
    return sendDisabledReason;
  }
  return chatConnectionPendingReason(host);
}

export function chatSendHoldReason(
  host: ChatHost,
  sessionKey: string,
  initialTurnPending = false,
  agentId?: string,
): string | null {
  return (
    (host.gatewayWorkPaused ? t("chat.queue.states.waitingForReconnect") : null) ??
    chatSendAdmissionHoldReason(host, sessionKey, agentId) ??
    chatSendPendingReason(host, sessionKey, initialTurnPending)
  );
}

function chatConnectionPendingReason(host: Pick<ChatHost, "client" | "connected">): string | null {
  return host.connected && host.client && !host.client.recoveryScopeReady
    ? t("chat.queue.connectionPending")
    : null;
}

// Sending waits for the authenticated outbox scope and locally owned session creation.
// Renderers show loading only for these transient holds, never terminal expiry.
export function chatSendPendingReason(
  host: Pick<ChatHost, "client" | "connected" | "hasPendingInitialTurn">,
  sessionKey: string,
  initialTurnPending = false,
): string | null {
  return (
    chatConnectionPendingReason(host) ??
    (initialTurnPending || host.hasPendingInitialTurn?.(sessionKey)
      ? t("chat.queue.initialTurnPending")
      : null)
  );
}

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

/** Surface a terminal delivery failure in the owning pane or a named toast. */
export function surfaceChatDeliveryFailure(
  host: Parameters<typeof visibleSessionMatches>[0] & {
    lastError?: string | null;
    chatError?: string | null;
    sessionsResult?: SessionsListResult | null;
  },
  sessionKey: string,
  agentId: string | undefined,
  error: string,
  options: { inline?: boolean } = {},
): void {
  const message = formatUiError(error);
  if (visibleSessionMatches(host, sessionKey, agentId)) {
    host.lastError = options.inline ? null : message;
    host.chatError = options.inline ? null : message;
    return;
  }
  const scopedAgentId = agentId ? normalizeAgentId(agentId) : undefined;
  const row = host.sessionsResult?.sessions.find(
    (session) =>
      areUiSessionKeysEquivalent(session.key, sessionKey) &&
      (!isUiGlobalSessionKey(sessionKey) ||
        !scopedAgentId ||
        (session.agentId !== undefined && normalizeAgentId(session.agentId) === scopedAgentId)),
  );
  showToast({ message: `${resolveSessionDisplayName(sessionKey, row)}: ${message}` });
}

export function prependReplyQuote(
  message: string,
  replyTarget: NonNullable<ChatHost["chatReplyTarget"]>,
): string {
  const label = (replyTarget.senderLabel ?? "User").replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");
  const text = replyTarget.text.trim();
  if (!text.includes("\n")) {
    return `> **${label}:** ${text}\n\n${message}`;
  }
  const quoted = text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `> **${label}:**\n${quoted}\n\n${message}`;
}
