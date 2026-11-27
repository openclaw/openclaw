import { isAbortTrigger } from "../../../../src/auto-reply/reply/abort-trigger-text.js";
import type { SessionsListResult } from "../../api/types.ts";
import { readOfflineStorageScope } from "../../app/boot-record.ts";
import { t } from "../../i18n/index.ts";
import { formatChatSelectionQuote } from "../../lib/chat/chat-selection-quote.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { parseSlashCommand } from "../../lib/chat/commands.ts";
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
import { chatProviderReviewRow } from "./chat-provider-review.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import type { ChatQueueAdmissionResult } from "./composer-queue-persistence.ts";

export function chatOfflineQueueStorageError(): string {
  return t("chat.queue.storageFailed");
}

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
  return editing ? t("chat.queue.editStorageFailed") : chatOfflineQueueStorageError();
}

export function isChatResetCommand(text: string) {
  const parsed = parseSlashCommand(text);
  return (
    parsed?.command.key === "new" ||
    (parsed?.command.key === "reset" && !/^soft(?:\s|$)/i.test(parsed.args))
  );
}

/** Commands and Goals never acquire ambient context, including during queued-row edits. */
export function acceptsChatAmbientContext(
  message: string,
  quotedMessage: string,
  intent?: ChatQueueItem["intent"],
): boolean {
  return (
    !intent &&
    !message.startsWith("/") &&
    !message.startsWith("!") &&
    !isAbortTrigger(quotedMessage)
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
  // A cold connection has no account to own an offline send yet. An established
  // account can still queue locally while its Gateway is disconnected.
  return host.client &&
    !host.client.recoveryScopeReady &&
    (host.connected || !readOfflineStorageScope(host))
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
  showToast({
    placement: "top-right",
    severity: "error",
    message: `${resolveSessionDisplayName(sessionKey, row)}: ${message}`,
  });
}

/** Model-facing text an annotation contributes ahead of the user's own message. */
export function annotationMessageContext(attachment: ChatAttachment): string | undefined {
  return attachment.selectionAnnotation
    ? formatChatSelectionQuote(attachment.selectionAnnotation)
    : attachment.browserAnnotation?.modelContext.trim();
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
