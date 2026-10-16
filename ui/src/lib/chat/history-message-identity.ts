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
  const receipt = history.inputReceipts?.find((input) => input.runId === item.sendRunId);
  return receipt?.state === "pending" && receipt.cancelled ? "cancelled" : receipt?.state;
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
  const projection = { ...record };
  delete projection.openclawResponsesInputReplay;
  if (metadata) {
    projection["__openclaw"] = projectionMetadata;
  }
  // History timestamps and provider replay data are not display identity.
  // Keep every other projection byte so siblings from one transcript row stay distinct.
  return `${sourceIdentity}:${JSON.stringify(projection)}`;
}

/** Preserve projected siblings while removing only overlapping page occurrences. */
export function prependUniqueNativeMessages(
  messages: unknown[],
  current: unknown[],
  replaceOverlapping = false,
): unknown[] {
  const incomingSources = new Set<string>();
  for (const message of messages) {
    const source = nativeHistoryMessageSourceIdentity(message);
    if (source) {
      incomingSources.add(source);
    }
  }
  const overlappingSources = new Set<string>();
  const duplicates = new Map<string, unknown[]>();
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
      const matches = duplicates.get(identity) ?? [];
      matches.push(message);
      duplicates.set(identity, matches);
    }
  }
  const uniqueMessages: unknown[] = [];
  for (const message of messages) {
    const source = nativeHistoryMessageSourceIdentity(message);
    const identity =
      source && overlappingSources.has(source) ? nativeHistoryMessageIdentity(message) : null;
    const matches = identity ? duplicates.get(identity) : undefined;
    if (replaceOverlapping) {
      uniqueMessages.push(matches?.shift() ?? message);
    } else if (matches?.length) {
      matches.pop();
    } else {
      uniqueMessages.push(message);
    }
  }
  // A zero-offset refill owns whole source groups, including changed display metadata.
  const retained = replaceOverlapping
    ? current.filter(
        (message) => !incomingSources.has(nativeHistoryMessageSourceIdentity(message) ?? ""),
      )
    : current;
  return [...uniqueMessages, ...retained];
}
