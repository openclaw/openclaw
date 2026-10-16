import type { OpenClawAgentDatabaseReadOnlyResult } from "../../state/openclaw-agent-db-readonly-open.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";

/** Payload bytes one read transaction captures before its JSON is parsed. */
export const TRANSCRIPT_PAYLOAD_CHUNK_BYTES = 2 * 1024 * 1024;

/** Payload text from one read transaction; `lastSeq` resumes the next one. */
export type TranscriptPayloadChunk = {
  payloads: Array<string | undefined>;
  lastSeq?: number;
  complete: boolean;
};

/** Copies payload text until `maxBytes` of payload are held. */
export function captureTranscriptPayloadChunk(
  maxBytes: number,
  /** `payload_bytes` is the payload size in UTF-8, or in the database text encoding when unrecorded. */
  rows: Iterable<{ seq: number; event_json: string; payload_bytes: number | null }>,
): TranscriptPayloadChunk {
  const chunk: TranscriptPayloadChunk = { payloads: [], complete: true };
  let bytes = 0;
  // Leaving the loop early or by a throw closes the iterator; no live cursor escapes a read.
  for (const row of rows) {
    chunk.payloads.push(row.event_json);
    chunk.lastSeq = row.seq;
    bytes += row.payload_bytes ?? row.event_json.length;
    if (bytes >= maxBytes) {
      chunk.complete = false;
      break;
    }
  }
  return chunk;
}

/** Parses captured payloads after their transaction closed, releasing each as it is consumed. */
function parseTranscriptPayloadChunk(
  chunk: TranscriptPayloadChunk,
  events: TranscriptEvent[],
  projectEvent?: (event: TranscriptEvent) => TranscriptEvent,
): void {
  const { payloads } = chunk;
  for (let index = 0; index < payloads.length; index++) {
    const payload = payloads[index];
    if (payload === undefined) {
      continue;
    }
    payloads[index] = undefined;
    const event: TranscriptEvent = JSON.parse(payload);
    events.push(projectEvent ? projectEvent(event) : event);
  }
}

/** Runs one short read transaction on a fresh database borrow. */
export type TranscriptSliceTransaction<Database> = <T>(
  read: (database: Database) => T,
) => OpenClawAgentDatabaseReadOnlyResult<T>;

/**
 * Reads a whole transcript as bounded slices of payload text, one short read transaction
 * each, and parses every slice after its transaction closed. Each later transaction first
 * compares the transcript context version (rewrite generation, raw seq, update time), the
 * token writers already validate loaded bytes against; on a change it returns undefined and
 * the caller rereads the transcript inside one transaction.
 */
export function readTranscriptEventsInSlices<
  Database,
  Head extends { beforeEventSeq?: number; afterEventSeq?: number; skipEvents?: boolean },
>(params: {
  transaction: TranscriptSliceTransaction<Database>;
  /** Reads the fence and snapshot facts in the first slice's transaction, given its version. */
  head: (database: Database, version: SessionTranscriptContextVersion) => Head;
  readVersion: (database: Database) => SessionTranscriptContextVersion;
  readSlice: (
    database: Database,
    range: { afterEventSeq?: number; beforeEventSeq?: number; first: boolean },
  ) => TranscriptPayloadChunk;
  projectEvent?: (event: TranscriptEvent) => TranscriptEvent;
}):
  | OpenClawAgentDatabaseReadOnlyResult<
      Head & { events: TranscriptEvent[]; version: SessionTranscriptContextVersion }
    >
  | undefined {
  const { transaction, readSlice, readVersion } = params;
  const first = transaction((database) => {
    const version = readVersion(database);
    const head = params.head(database, version);
    return {
      head,
      chunk: head.skipEvents
        ? { payloads: [], complete: true }
        : readSlice(database, {
            afterEventSeq: head.afterEventSeq,
            beforeEventSeq: head.beforeEventSeq,
            first: true,
          }),
      version,
    };
  });
  if (!first.found) {
    return first;
  }
  const { head, version } = first.value;
  const events: TranscriptEvent[] = [];
  let chunk: TranscriptPayloadChunk | undefined = first.value.chunk;
  while (chunk) {
    parseTranscriptPayloadChunk(chunk, events, params.projectEvent);
    if (chunk.complete) {
      return { found: true, value: { ...head, events, version } };
    }
    const afterEventSeq: number | undefined = chunk.lastSeq;
    const next = transaction((database): TranscriptPayloadChunk | undefined =>
      isSameTranscriptContextVersion(readVersion(database), version)
        ? readSlice(database, { afterEventSeq, beforeEventSeq: head.beforeEventSeq, first: false })
        : undefined,
    );
    if (!next.found) {
      return next;
    }
    chunk = next.value;
  }
  return undefined;
}

/** A later slice continues the first one only while the transcript context version is unchanged. */
export function isSameTranscriptContextVersion(
  left: SessionTranscriptContextVersion,
  right: SessionTranscriptContextVersion,
): boolean {
  return (
    left.generation === right.generation &&
    left.rawSeq === right.rawSeq &&
    left.updatedAt === right.updatedAt
  );
}
