import assert from "node:assert/strict";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as snapshots from "../../infra/sqlite-transaction.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { retainSessionColdNavigationInTransaction } from "./session-cold-storage-navigation.js";
import { prepareSessionColdBatchInWorker } from "./session-cold-storage-prepare.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { mutateSessionColdTranscriptInWorker } from "./session-cold-storage-worker.js";
import {
  createSessionColdStorageFixture,
  currentId,
  historicalId,
} from "./session-cold-storage.test-support.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

vi.mock("./session-cold-storage-codec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-cold-storage-codec.js")>()),
  MAX_COLD_ARCHIVE_BYTES: 4096,
}));

type Fixture = Awaited<ReturnType<typeof createSessionColdStorageFixture>>;
afterEach(() => vi.restoreAllMocks());

const withFixture = (run: (fixture: Fixture) => Promise<void>, utf16 = false) =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const path = state.statePath("oversized.sqlite");
    if (utf16) {
      using seed = new DatabaseSync(path);
      seed.exec(
        "PRAGMA encoding='UTF-16le'; CREATE TABLE encoding_probe(value TEXT); DROP TABLE encoding_probe;",
      );
    }
    const fixture = await createSessionColdStorageFixture(path);
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    await run(fixture);
  });

function prepare(options: Fixture["options"]) {
  return prepareSessionColdBatchInWorker({
    databaseOptions: options,
    admissionIdentities: [],
    liveSessionKeys: [],
    cooledSessionIds: [],
    beforeMs: 100,
    maxTranscripts: 128,
    maxBytes: 4096,
  });
}

function largestEventBytes(events: Fixture["original"]["events"]) {
  return events
    .filter((event) => event.session_id === historicalId)
    .reduce((bytes, event) => {
      // The original snapshot precedes archival and decodes compressed payloads.
      assert(event.event_json !== null);
      return Math.max(bytes, Buffer.byteLength(event.event_json));
    }, 0);
}

it("clears prepared navigation in one update without changing its retained facts", () =>
  withFixture(async (fixture) => {
    await replaceTranscriptEvents(
      fixture.scope,
      Array.from({ length: 8 }, (_, index) => ({
        type: "message",
        id: `large-${index}`,
        parentId: index ? `large-${index - 1}` : null,
        message: { role: "user", content: "synthetic repeated payload ".repeat(100) },
      })),
    );
    await waitForSessionTranscriptIndexReconcile(fixture.options);
    const database = fixture.database();
    const read = () =>
      database
        .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(historicalId);
    const before = read();
    expect(before).toHaveLength(8);
    expect(before.every((row) => row.navigation_json !== null)).toBe(true);
    const work = trackSqliteStatementExecutions(database, ["update"], (sql) =>
      sql.startsWith('update "transcript_events"') ? "update" : null,
    );
    try {
      runOpenClawAgentWriteTransaction(
        (current) => retainSessionColdNavigationInTransaction(current, historicalId),
        fixture.options,
      );
      expect(work.counts.update).toBe(1);
      expect(read()).toEqual(
        before.map((row) => Object.assign({}, row, { event_json: null, event_zstd: null })),
      );
    } finally {
      work.restore();
    }
  }));

it("defers event size reads until preparation and rejects oversized bytes before snapshotting", () =>
  withFixture(async (fixture) => {
    // Exercise legacy identity accounting alongside the fixture's compressed event payload.
    fixture
      .database()
      .prepare("UPDATE transcript_events SET event_utf8_bytes = NULL WHERE seq = 0")
      .run();
    const payloadReads: string[] = [];
    const read = snapshots.runSqliteReadSnapshotSync;
    const snapshot = vi
      .spyOn(snapshots, "runSqliteReadSnapshotSync")
      .mockImplementation((database, run, options) => {
        if (options?.operationLabel !== "cold transcript selection") {
          return read(database, run, options);
        }
        const native = requireNativeSqliteDatabase(database);
        native.setAuthorizer((action, table, column) => {
          if (
            action === constants.SQLITE_READ &&
            table === "transcript_events" &&
            (column === "event_json" || column === "event_utf8_bytes")
          ) {
            payloadReads.push(column);
          }
          return constants.SQLITE_OK;
        });
        try {
          return read(database, run, options);
        } finally {
          native.setAuthorizer(null);
        }
      });
    const batch = await prepare(fixture.options);
    expect(payloadReads).toEqual([]);
    expect(
      snapshot.mock.calls.filter((call) => call[2]?.operationLabel === "cold transcript snapshot"),
    ).toHaveLength(0);
    expect({ oversized: batch.oversizedTranscripts, bytes: batch.envelopeBytes }).toEqual({
      oversized: [
        { sessionId: historicalId, lowerBoundBytes: largestEventBytes(fixture.original.events) },
      ],
      bytes: 0,
    });
  }));

it("bounds UTF-16 stores by UTF-8 bytes instead of stored UTF-16 bytes", () =>
  withFixture(async (fixture) => {
    const batch = await prepare(fixture.options);
    const [oversized] = batch.oversizedTranscripts;
    expect(oversized?.sessionId).toBe(historicalId);
    // Stored UTF-16 bytes double ASCII text; overestimating skips archivable windows.
    expect(oversized?.lowerBoundBytes).toBeLessThanOrEqual(
      largestEventBytes(fixture.original.events),
    );
  }, true));

it("archives the next eligible window in the same pass after an oversized window", () =>
  withFixture(async (fixture) => {
    fixture
      .database()
      .prepare(
        "UPDATE session_windows SET updated_at = 2, transcript_updated_at = 2 WHERE session_id = ?",
      )
      .run(currentId);
    const batch = await prepare(fixture.options);
    const result = mutateSessionColdTranscriptInWorker(
      {
        kind: "cold-batch",
        databaseOptions: fixture.options,
        prepared: batch.prepared,
        externalizations: batch.externalizations,
        protectionKeys: batch.protectionKeys,
        beforeMs: 100,
        liveSessionKeys: [],
      },
      undefined,
      () => {},
    );
    expect(result.archivedTranscripts).toBe(1);
    expect(readSessionColdTranscript(fixture.database(), currentId)?.event_count).toBe(1);
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
  }));
