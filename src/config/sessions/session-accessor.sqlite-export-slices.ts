import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabaseReadOnlyResult } from "../../state/openclaw-agent-db-readonly-open.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { readHotSessionTranscriptSnapshot } from "./session-cold-storage-state.js";
import { SessionTranscriptColdError } from "./session-transcript-cold-error.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import {
  TRANSCRIPT_PAYLOAD_SLICE_BYTES,
  transcriptEventReadBytesSql,
} from "./session-transcript-read-bytes.js";
import { readTranscriptPayload } from "./transcript-payload.js";

type ExportDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;

/** Rows an export head left to a sliced read, and the context version it was read at. */
type DeferredTranscriptRows = {
  deferred?: { afterSeq?: number; throughSeq: number; version: SessionTranscriptContextVersion };
};

/** Payload text from one read transaction; `resumeAfterSeq` is set when the budget ended it. */
type TranscriptPayloadSlice = { payloads: Array<string | undefined>; resumeAfterSeq?: number };

type TranscriptExportSliceParams<Snapshot> = {
  sessionId: string;
  /** Runs one short read transaction on a fresh database borrow. */
  transaction: <T>(read: (database: ExportDatabase) => T) => OpenClawAgentDatabaseReadOnlyResult<T>;
  /** The export snapshot in the caller's transaction; `deferAboveBytes: 0` leaves its rows unread. */
  readHead: (database: ExportDatabase, slicing?: { deferAboveBytes: number }) => Snapshot | "cold";
  /** A deferred head the caller's batch transaction already read. */
  batchHead?: Snapshot;
  projectEvent?: (event: TranscriptEvent) => TranscriptEvent;
};

/** A sliced export observed a transcript context version change after its first slice. */
export class SessionTranscriptExportChangedError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session transcript ${sessionId} changed during a sliced export`);
    this.name = "SessionTranscriptExportChangedError";
  }
}

/**
 * Opens one export: the head in the first slice's transaction (or the batch head while the
 * transcript context version still matches it). Its `events` iterate the head's rows, then read
 * the deferred rows in bounded slices, one short read transaction each, parsed after that
 * transaction closed. Each later slice first compares the transcript context version, the token
 * writers already validate loaded bytes against, and throws `SessionTranscriptExportChangedError`
 * on a change. Iteration retains no rows it already yielded.
 */
export function openTranscriptExportInSlices<
  Snapshot extends DeferredTranscriptRows & { events: TranscriptEvent[] },
>(params: TranscriptExportSliceParams<Snapshot>) {
  const { sessionId, transaction, batchHead, projectEvent } = params;
  const first = transaction((database) => {
    const snapshot =
      batchHead?.deferred &&
      isSameTranscriptContextVersion(
        readTranscriptContextVersionInTransaction(database, sessionId),
        batchHead.deferred.version,
      )
        ? batchHead
        : hotExportSnapshot(sessionId, params.readHead(database, { deferAboveBytes: 0 }));
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
  const { deferred, events: headEvents, ...snapshot } = first.value.snapshot;
  let firstSlice = first.value.slice;
  function* events(): Generator<TranscriptEvent, void, undefined> {
    yield* headEvents;
    let slice = firstSlice;
    firstSlice = undefined;
    while (slice) {
      // Each captured payload is released as it is parsed.
      const { payloads } = slice;
      for (let index = 0; index < payloads.length; index++) {
        const event: TranscriptEvent = JSON.parse(payloads[index]!);
        payloads[index] = undefined;
        yield projectEvent ? projectEvent(event) : event;
      }
      const afterSeq = slice.resumeAfterSeq;
      if (afterSeq === undefined || !deferred) {
        return;
      }
      const next = transaction((database) =>
        isSameTranscriptContextVersion(
          readTranscriptContextVersionInTransaction(database, sessionId),
          deferred.version,
        )
          ? readTranscriptPayloadSlice(database, sessionId, deferred, afterSeq)
          : undefined,
      );
      if (!next.found || !next.value) {
        throw new SessionTranscriptExportChangedError(sessionId);
      }
      slice = next.value;
    }
  }
  return { snapshot, events: events() };
}

/**
 * Reads one complete export snapshot through `openTranscriptExportInSlices`. On a version change
 * the transcript is reread inside one transaction.
 */
export function readTranscriptExportInSlices<
  Snapshot extends DeferredTranscriptRows & { events: TranscriptEvent[] },
>(params: TranscriptExportSliceParams<Snapshot> & { projection?: "reset-boundary" }) {
  const { sessionId, transaction } = params;
  const readWhole = () => {
    const whole = transaction((database) =>
      hotExportSnapshot(sessionId, params.readHead(database)),
    );
    if (!whole.found) {
      return undefined;
    }
    const { deferred: _deferred, ...snapshot } = whole.value;
    return snapshot;
  };
  // Reset navigation is a small native projection and stays in one transaction.
  if (params.projection === "reset-boundary") {
    return readWhole();
  }
  const opened = openTranscriptExportInSlices(params);
  if (!opened) {
    return undefined;
  }
  try {
    return { ...opened.snapshot, events: [...opened.events] };
  } catch (error) {
    if (!(error instanceof SessionTranscriptExportChangedError)) {
      throw error;
    }
    return readWhole();
  }
}

function hotExportSnapshot<Snapshot>(sessionId: string, snapshot: Snapshot | "cold"): Snapshot {
  if (snapshot === "cold") {
    throw new SessionTranscriptColdError(sessionId);
  }
  return snapshot;
}

/** Captures decoded payload text after `afterSeq` up to the slice budget. */
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
        .select(["seq", "event_json", "event_zstd", "event_utf8_bytes"])
        .select(transcriptEventReadBytesSql().as("payload_bytes"))
        .where("session_id", "=", sessionId)
        .where("seq", "<=", throughSeq)
        .$if(afterSeq !== undefined, (query) => query.where("seq", ">", afterSeq!))
        .orderBy("seq", "asc"),
    )) {
      slice.payloads.push(readTranscriptPayload(row));
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
