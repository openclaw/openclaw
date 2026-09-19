import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatInputReceipts } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";

/** Exact custody is independent of display pagination, but stays physical-session scoped. */
export function readChatInputReceipt(
  history: {
    inputReceipts?: ChatInputReceipts;
    sessionInfo?: { sessionId?: string };
    sessionId?: string;
  },
  item: { sendRunId?: string; sessionId?: string },
) {
  if (
    !item.sendRunId ||
    (item.sessionId && item.sessionId !== (history.sessionInfo?.sessionId ?? history.sessionId))
  ) {
    return undefined;
  }
  return history.inputReceipts?.find((input) => input.runId === item.sendRunId)?.state;
}

/** Submission proof uses the recorded key, never execution correlation. */
export function findChatSubmissionMessage(
  messages: unknown,
  runId: string | undefined,
  userRoleOnly = false,
) {
  let match = null;
  if (!runId || !Array.isArray(messages)) {
    return match;
  }
  for (const message of messages) {
    const identity = readSessionMessageIdentity(message);
    if (
      identity &&
      (!userRoleOnly || identity.role === "user") &&
      (identity.idempotencyKey === runId || identity.idempotencyKey === `${runId}:user`)
    ) {
      match = identity;
      // A durable user receipt supersedes a local display copy in the same batch.
      if (identity.id !== null || identity.sequence !== null) {
        return identity;
      }
    }
  }
  return match;
}

function nativeHistoryMessageSourceIdentity(message: unknown): string | null {
  const record = asNullableRecord(message);
  const metadata = asNullableRecord(record?.["__openclaw"]);
  const seq = metadata?.seq;
  const id = metadata?.id ?? record?.messageId;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0
    ? `seq:${seq}`
    : typeof id === "string" && id.trim()
      ? `id:${id}`
      : null;
}

export function nativeHistoryMessageIdentity(message: unknown): string | null {
  const sourceIdentity = nativeHistoryMessageSourceIdentity(message);
  if (!sourceIdentity) {
    return null;
  }
  const record = asNullableRecord(message);
  const metadata = asNullableRecord(record?.["__openclaw"]);
  const { recordTimestampMs: _recordTimestampMs, ...projectionMetadata } = metadata ?? {};
  const projection = metadata ? { ...record, __openclaw: projectionMetadata } : record;
  try {
    // History alone adds recordTimestampMs; delivery metadata is not projection identity.
    // Keep every other projection byte so siblings from one transcript row stay distinct.
    return `${sourceIdentity}:${JSON.stringify(projection)}`;
  } catch {
    return sourceIdentity;
  }
}

/** Preserve projected siblings while removing only overlapping page occurrences. */
export function prependUniqueNativeMessages(messages: unknown[], current: unknown[]): unknown[] {
  const incomingSources = new Set<string>();
  for (const message of messages) {
    const source = nativeHistoryMessageSourceIdentity(message);
    if (source) {
      incomingSources.add(source);
    }
  }
  const overlappingSources = new Set<string>();
  const duplicateCounts = new Map<string, number>();
  for (const message of current) {
    const source = nativeHistoryMessageSourceIdentity(message);
    if (!source || !incomingSources.has(source)) {
      continue;
    }
    // Most older pages have disjoint sources. Only overlapping rows need
    // content comparison; keep counts local so hydrated projections stay fresh.
    const identity = nativeHistoryMessageIdentity(message);
    if (identity) {
      overlappingSources.add(source);
      duplicateCounts.set(identity, (duplicateCounts.get(identity) ?? 0) + 1);
    }
  }
  const uniqueMessages = messages.filter((message) => {
    const source = nativeHistoryMessageSourceIdentity(message);
    if (!source || !overlappingSources.has(source)) {
      return true;
    }
    const identity = nativeHistoryMessageIdentity(message);
    const remaining = identity ? (duplicateCounts.get(identity) ?? 0) : 0;
    if (!identity || remaining === 0) {
      return true;
    }
    duplicateCounts.set(identity, remaining - 1);
    return false;
  });
  return [...uniqueMessages, ...current];
}
