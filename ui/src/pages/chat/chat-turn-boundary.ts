import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatItem, MessageGroup, NormalizedMessage } from "../../lib/chat/chat-types.ts";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
  resolveMessageRole,
} from "../../lib/chat/message-normalizer.ts";

export function safeNormalizeMessage(message: unknown): NormalizedMessage | null {
  if (!asRecord(message)) {
    return null;
  }
  try {
    return normalizeMessage(message);
  } catch {
    return null;
  }
}

export function readAutomationRun(message: unknown) {
  const provenance = asRecord(asRecord(message)?.provenance);
  if (provenance?.kind !== "internal_system" || provenance.sourceTool !== "cron") {
    return undefined;
  }
  const { jobId, runId, sourceSessionKey } = provenance;
  return typeof jobId === "string" &&
    jobId &&
    typeof runId === "string" &&
    runId &&
    typeof sourceSessionKey === "string" &&
    sourceSessionKey
    ? { jobId, runId, sourceSessionKey }
    : undefined;
}

function messageIsForwardedBoundary(message: unknown): boolean {
  const provenance = asRecord(asRecord(message)?.provenance);
  return (
    (provenance?.kind === "inter_session" && provenance.sourceTool === "sessions_send") ||
    Boolean(readAutomationRun(message))
  );
}

export function assistantGroupIsForwardedBoundary(group: MessageGroup): boolean {
  return group.messages.some(({ message }) => messageIsForwardedBoundary(message));
}

export function isInterSessionMessage(message: unknown): boolean {
  const provenance = asRecord(asRecord(message)?.provenance);
  return provenance?.kind === "inter_session";
}

export function isSessionActivityGroup(group: MessageGroup): boolean {
  return (
    group.role === "assistant" &&
    !group.isStreaming &&
    group.messages.length > 0 &&
    group.messages.every(
      ({ message }) => isInterSessionMessage(message) || readAutomationRun(message),
    )
  );
}

// Display attribution also accepts projected source metadata; turn ownership
// above requires the original forwarded-input provenance.
export function hasForwardedSource(group: MessageGroup): boolean {
  return Boolean(group.senderSession) || assistantGroupIsForwardedBoundary(group);
}

function messageStartsProjectedTurnBoundary(message: unknown): boolean {
  return asRecord(asRecord(message)?.["__openclaw"])?.turnBoundary === true;
}

/** Canonical user-turn boundary shared by insertion, outcome, and collapse projections. */
export function chatItemStartsUserTurn(item: ChatItem | MessageGroup): boolean {
  if (item.kind === "notice") {
    return item.startsTurn === true;
  }
  if (item.kind === "message") {
    const role = normalizeRoleForGrouping(resolveMessageRole(item.message));
    return (
      item.startsTurn === true ||
      role === "user" ||
      messageStartsProjectedTurnBoundary(item.message) ||
      (role === "assistant" && messageIsForwardedBoundary(item.message))
    );
  }
  if (item.kind !== "group") {
    return false;
  }
  const role = item.role.toLowerCase();
  return (
    role === "user" ||
    messageStartsProjectedTurnBoundary(item.messages[0]?.message) ||
    (role === "assistant" && assistantGroupIsForwardedBoundary(item))
  );
}

/** Display segments also separate projected sources, without claiming execution ownership. */
export function chatItemStartsDisplayTurn(item: ChatItem | MessageGroup): boolean {
  if (chatItemStartsUserTurn(item)) {
    return true;
  }
  if (item.kind === "group") {
    return normalizeRoleForGrouping(item.role) === "assistant" && hasForwardedSource(item);
  }
  const message = item.kind === "message" ? safeNormalizeMessage(item.message) : null;
  return Boolean(
    message && normalizeRoleForGrouping(message.role) === "assistant" && message.senderSession,
  );
}
