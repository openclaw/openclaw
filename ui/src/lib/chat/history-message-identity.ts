import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

export function readChatThreadMessageIdentity(message: unknown) {
  const record = asNullableRecord(message);
  const surfaceId =
    typeof record?.messageId === "string" && record.messageId.trim()
      ? record.messageId
      : record?.id;
  return readSessionMessageIdentity(message, { messageId: surfaceId });
}

/** Causal boundaries follow execution ownership, which can differ from the submit key. */
export function userTurnRunId(message: unknown): string | null {
  const identity = readChatThreadMessageIdentity(message);
  return identity?.role === "user" ? identity.runId : null;
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

/** Gateway anchor IDs also belong to roleless status and compaction rows. */
export function nativeHistoryMessageSourceId(message: unknown): string | null {
  const id = asNullableRecord(asNullableRecord(message)?.["__openclaw"])?.id;
  return typeof id === "string" && id ? id : null;
}

export function nativeHistoryMessageSourceIdentity(message: unknown): string | null {
  const record = asNullableRecord(message);
  const metadata = asNullableRecord(record?.["__openclaw"]);
  const seq = metadata?.seq;
  const identity = readSessionMessageIdentity(message);
  if (identity?.isImported && identity.externalSource) {
    return `import:${identity.externalSource}`;
  }
  const id = nativeHistoryMessageSourceId(message);
  return id
    ? `id:${id}`
    : typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0
      ? `seq:${seq}`
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
