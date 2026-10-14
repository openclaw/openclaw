import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionActorTranscriptRow } from "./session-actor-bounded-history.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import type { SessionTranscriptContextMetadata } from "./session-transcript-projection-facts.types.js";

const MAX_CONTEXT_METADATA_ROWS = 4096;

/** Reuse stored byte lengths; parsed navigation never establishes payload size. */
export function projectSessionActorContextMetadata(
  actor: SessionActorStoredState,
): SessionTranscriptContextMetadata | undefined {
  const { active, coldArchive, contextMetadata, identities, navigation, payloads, projection } =
    actor.transcript;
  if (
    coldArchive ||
    !contextMetadata ||
    !projection ||
    projection.needsRebuild ||
    projection.hasUnclassifiedEvents ||
    [...identities.values()].some(
      (row) => row.event_type === "reset" || row.event_type === "compaction",
    ) ||
    navigation.some((row) => ["reset", "compaction", "leaf", "branch_summary"].includes(row.type))
  ) {
    return undefined;
  }
  const priorBytes = new Map(
    contextMetadata.rows.map((row) => [row.event_seq, row.serialized_bytes]),
  );
  const rows: SessionTranscriptContextMetadata["rows"] = [];
  let sizeBytes = 0;
  for (const row of active.values()) {
    if (row.context_eligible !== 1) {
      continue;
    }
    const bytes = payloads.get(row.event_seq)?.serializedBytes ?? priorBytes.get(row.event_seq);
    if (bytes === undefined || rows.length === MAX_CONTEXT_METADATA_ROWS) {
      return undefined;
    }
    rows.push({
      event_seq: row.event_seq,
      active_position: row.active_position,
      serialized_bytes: bytes,
    });
    sizeBytes += bytes;
  }
  let header = contextMetadata.header;
  if (!header) {
    for (const [seq, payload] of payloads) {
      if (isRecord(payload.event) && payload.event.type === "session") {
        header = { seq, navigation_valid: 1, serialized_bytes: payload.serializedBytes };
        break;
      }
    }
  }
  return {
    header,
    rows: rows.toSorted((left, right) => right.active_position - left.active_position),
    boundaryCount: 0,
    eventCount: rows.length,
    sizeBytes,
  };
}

export function rewriteSessionActorContextMetadata(
  actor: SessionActorStoredState,
  rewritten: SessionActorTranscriptRow[],
): void {
  const metadata = actor.transcript.contextMetadata;
  if (!metadata) {
    return;
  }
  const bytes = new Map(rewritten.map((row) => [row.rawSeq, row.serializedBytes]));
  actor.transcript.contextMetadata = {
    ...metadata,
    rows: metadata.rows.map((row) => ({
      event_seq: row.event_seq,
      active_position: row.active_position,
      serialized_bytes: bytes.get(row.event_seq) ?? row.serialized_bytes,
    })),
  };
}

/** Initial bytes ride the actor's existing navigation hydration statement. */
export function seedSessionActorContextMetadata(
  actor: SessionActorStoredState,
  stored: Array<{
    seq: number;
    navigation_type: string | null;
    navigation_valid: number;
    serialized_bytes: number;
  }>,
): void {
  const rows = stored.flatMap((row) => {
    const active = actor.transcript.active.get(row.seq);
    return active?.context_eligible === 1
      ? [
          {
            event_seq: row.seq,
            active_position: active.active_position,
            serialized_bytes: row.serialized_bytes,
          },
        ]
      : [];
  });
  if (rows.length > MAX_CONTEXT_METADATA_ROWS) {
    return;
  }
  const first = stored.find(
    (row) => row.navigation_type === "session" || row.navigation_valid === 0,
  );
  actor.transcript.contextMetadata = {
    header: first && {
      seq: first.seq,
      navigation_valid: first.navigation_valid,
      serialized_bytes: first.serialized_bytes,
    },
    rows,
    boundaryCount: 0,
    eventCount: rows.length,
    sizeBytes: rows.reduce((total, row) => total + row.serialized_bytes, 0),
  };
}
