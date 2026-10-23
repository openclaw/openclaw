import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { OpenClawAgentDatabaseReadOnlyResult } from "../../state/openclaw-agent-db-readonly-open.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  TranscriptEvent,
  SessionTranscriptReadScope,
  SessionTranscriptStats,
} from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope-helpers.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { readHotSessionTranscriptSnapshot } from "./session-cold-storage-read.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import {
  TRANSCRIPT_PAYLOAD_SLICE_BYTES,
  transcriptEventReadBytesSql,
} from "./session-transcript-read-bytes.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

export type TranscriptExportOptions = {
  projection?: "reset-boundary";
  /** Reduce each decoded event synchronously before retaining the snapshot. */
  projectEvent?: (event: TranscriptEvent) => TranscriptEvent;
  /** Worker-owned projection from the preceding export; null starts an incremental reader. */
  previous?: {
    events: TranscriptEvent[];
    generation: string | null;
    throughSeq: number;
  } | null;
};

export type TranscriptExportSnapshot = {
  events: TranscriptEvent[];
  stats: SessionTranscriptStats;
  sessionKey: string | undefined;
  generation?: string | null;
  throughSeq?: number;
  /**
   * Rows after `afterSeq` through `throughSeq` that a sliced read still has to add, and the
   * transcript context version this head was read at.
   */
  deferred?: { afterSeq?: number; throughSeq: number; version: SessionTranscriptContextVersion };
};

export type TranscriptExportRequest = {
  resolved: ResolvedTranscriptReadScope;
  scope: SessionTranscriptReadScope;
  options: TranscriptExportOptions;
  admission?: UserTurnTranscriptAdmissionReceipt;
  sink?: TranscriptExportSink;
};

export type TranscriptExportRead = {
  request: TranscriptExportRequest;
  snapshot: TranscriptExportSnapshot;
  throughSeq: number;
  afterSeq?: number;
};

type ExportDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;

/** Rows an export head left to a sliced read, and the context version it was read at. */
type DeferredTranscriptRows = {
  deferred?: { afterSeq?: number; throughSeq: number; version: SessionTranscriptContextVersion };
};

/** Payload text from one read transaction; `resumeAfterSeq` is set when the budget ended it. */
type TranscriptPayloadSlice = { payloads: Array<string | undefined>; resumeAfterSeq?: number };

/** Private export destination; restarting a snapshot must discard its earlier rows. */
export type TranscriptExportSink = { write: (json: string) => void; reset: () => void };

/**
 * Reads one export snapshot: the head in the first slice's transaction (or the batch head while
 * the transcript context version still matches it), then its deferred rows in bounded slices,
 * one short read transaction each, parsed after that transaction closed. Every later slice first
 * compares the transcript context version, the token writers already validate loaded bytes
 * against; on a change the transcript is reread inside one transaction.
 */
export function readTranscriptExportInSlices<
  Snapshot extends DeferredTranscriptRows & { events: TranscriptEvent[] },
>(params: {
  sessionId: string;
  /** Runs one short read transaction on a fresh database borrow. */
  transaction: <T>(read: (database: ExportDatabase) => T) => OpenClawAgentDatabaseReadOnlyResult<T>;
  /** The export snapshot in the caller's transaction; `deferAboveBytes: 0` leaves its rows unread. */
  readHead: (database: ExportDatabase, slicing?: { deferAboveBytes: number }) => Snapshot | "cold";
  /** A deferred head the caller's batch transaction already read. */
  batchHead?: Snapshot;
  projection?: "reset-boundary";
  projectEvent?: (event: TranscriptEvent) => TranscriptEvent;
  sink?: TranscriptExportSink;
}) {
  const { sessionId, transaction, batchHead, projectEvent, sink } = params;
  const hot = (snapshot: Snapshot | "cold") => {
    if (snapshot === "cold") {
      throw new SessionTranscriptColdError(sessionId);
    }
    return snapshot;
  };
  const readWhole = () => {
    // A changed revision cannot append to the partial prepared source. The rare stable
    // copy holds one read transaction for disk I/O, but decoding stays outside it.
    sink?.reset();
    const whole = transaction((database) => hot(params.readHead(database)));
    return whole.found ? whole.value : undefined;
  };
  // Reset navigation is a small native projection and stays in one transaction.
  if (params.projection === "reset-boundary") {
    return readWhole();
  }
  const first = transaction((database) => {
    const snapshot =
      batchHead?.deferred &&
      isSameTranscriptContextVersion(
        readTranscriptContextVersionInTransaction(database, sessionId),
        batchHead.deferred.version,
      )
        ? batchHead
        : hot(params.readHead(database, { deferAboveBytes: 0 }));
    const { deferred } = snapshot;
    return {
      snapshot,
      slice:
        deferred && readTranscriptPayloadSlice(database, sessionId, deferred, deferred.afterSeq),
    };
  });
  if (!first.found) {
    return undefined;
  }
  const { deferred, ...snapshot } = first.value.snapshot;
  if (!deferred) {
    return snapshot;
  }
  const events = [...snapshot.events];
  let slice = first.value.slice;
  while (slice) {
    // Release each captured payload after parsing or copying it to the prepared source.
    const { payloads } = slice;
    for (let index = 0; index < payloads.length; index++) {
      const payload = payloads[index]!;
      payloads[index] = undefined;
      if (sink) {
        sink.write(payload);
      } else {
        const event: TranscriptEvent = JSON.parse(payload);
        events.push(projectEvent ? projectEvent(event) : event);
      }
    }
    const afterSeq = slice.resumeAfterSeq;
    if (afterSeq === undefined) {
      break;
    }
    const next = transaction((database) =>
      isSameTranscriptContextVersion(
        readTranscriptContextVersionInTransaction(database, sessionId),
        deferred.version,
      )
        ? readTranscriptPayloadSlice(database, sessionId, deferred, afterSeq)
        : undefined,
    );
    if (!next.found) {
      return undefined;
    }
    if (!next.value) {
      return readWhole();
    }
    slice = next.value;
  }
  return { ...snapshot, events };
}

/** Captures payload text after `afterSeq`, decoded by SQLite, up to the slice budget. */
function readTranscriptPayloadSlice(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  { throughSeq }: { throughSeq: number },
  afterSeq: number | undefined,
): TranscriptPayloadSlice {
  return readHotSessionTranscriptSnapshot(database, sessionId, "events", () => {
    const slice: TranscriptPayloadSlice = { payloads: [] };
    let bytes = 0;
    // Leaving the loop early or by a throw closes the iterator; no live cursor escapes a read.
    for (const row of iterateSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select([
          "seq",
          transcriptEventJsonSql(database.db).as("event_json"),
          transcriptEventReadBytesSql().as("payload_bytes"),
        ])
        .where("session_id", "=", sessionId)
        .where("seq", "<=", throughSeq)
        .$if(afterSeq !== undefined, (query) => query.where("seq", ">", afterSeq!))
        .orderBy("seq", "asc"),
    )) {
      slice.payloads.push(row.event_json);
      bytes += row.payload_bytes;
      if (bytes >= TRANSCRIPT_PAYLOAD_SLICE_BYTES) {
        slice.resumeAfterSeq = row.seq;
        break;
      }
    }
    return slice;
  });
}

function isSameTranscriptContextVersion(
  left: SessionTranscriptContextVersion,
  right: SessionTranscriptContextVersion,
): boolean {
  return (
    left.generation === right.generation &&
    left.rawSeq === right.rawSeq &&
    left.updatedAt === right.updatedAt
  );
}
