import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  hasSessionTranscriptEventsSync,
  readTranscriptMutationAtSync,
  readTranscriptMutationStateSync,
} from "./session-accessor.sqlite-metadata-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  advanceTranscriptMutationAtInTransaction,
  readTranscriptMutationStateInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import { readTranscriptStatsFromDatabase } from "./session-accessor.sqlite-transcript-stats.js";
import { readSessionTranscriptAnchorsAsync } from "./session-transcript-anchor-read.js";

afterEach(() => vi.restoreAllMocks());

function createFixture(state: OpenClawTestState, agentId = "main") {
  const options = { agentId, env: state.env };
  const scope = (sessionId: string) => ({
    ...options,
    sessionId,
    sessionKey: `agent:${agentId}:${sessionId}`,
  });
  // Native seeding leaves the manually assigned mutation fences free of maintenance writers.
  for (const sessionId of ["hot", "cold", "empty"]) {
    replaceSessionEntrySync(scope(sessionId), { sessionId, updatedAt: 1 });
  }
  const database = openOpenClawAgentDatabase(options);
  database.db.exec(`
    INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES ('hot', 0, '{"type":"session"}', 1);
    INSERT INTO session_transcript_cold_archives
      (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
       archive_bytes, last_seq, archived_at, storage)
    VALUES ('cold', 'generation', 'missing.jsonl.zst', '${"0".repeat(64)}', 1, 1, 1, 0, 1, 'file');
    UPDATE session_windows SET transcript_observed_at = 10, transcript_updated_at = 20
      WHERE session_id = 'hot';
    UPDATE session_windows SET transcript_observed_at = 30, transcript_updated_at = 40
      WHERE session_id = 'cold';
  `);
  return { database, options, scope };
}

it("reads physical hot and cold presence with mutation pairs off-thread without restoring payloads", async () => {
  await withOpenClawTestState({ label: "worker-transcript-metadata" }, async (state) => {
    const { scope } = createFixture(state);
    const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      const values = [];
      for (const sessionId of ["hot", "cold", "empty", "missing"]) {
        values.push(
          (
            await readSessionTranscriptAnchorsAsync(scope(sessionId), {
              entryIds: [],
              includeMetadata: true,
            })
          ).metadata,
        );
      }
      expect(values).toEqual([
        { present: true, observedAt: 10, updatedAt: 20 },
        { present: true, observedAt: 30, updatedAt: 40 },
        { present: false, observedAt: 1, updatedAt: null },
        { present: false, observedAt: null, updatedAt: null },
      ]);
      expect(
        observation.queries.filter((query) =>
          /\b(?:transcript_events|session_windows|session_transcript_cold_archives)\b/i.test(query),
        ),
      ).toEqual([]);
    } finally {
      observation.restore();
    }
  });
});

it.each(["presence", "mutation"] as const)(
  "keeps fresh bindings and rows without recompiling warm transcript %s reads",
  async (kind) => {
    await withOpenClawTestState({ label: "prepared-transcript-bindings" }, async (state) => {
      const { database, options, scope } = createFixture(state);
      const read =
        kind === "presence" ? hasSessionTranscriptEventsSync : readTranscriptMutationStateSync;
      const expected = {
        presence: [true, true, false, false],
        mutation: [
          { observedAt: 10, updatedAt: 20 },
          { observedAt: 30, updatedAt: 40 },
          // Entry creation records updatedAt before any transcript mutation.
          { observedAt: 1, updatedAt: null },
          { observedAt: null, updatedAt: null },
        ],
      }[kind];
      const ids = ["hot", "cold", "empty", "missing"];
      for (const [index, id] of ids.entries()) {
        expect(read(scope(id))).toEqual(expected[index]);
      }
      const compile = vi.spyOn(getSessionKysely(database.db).getExecutor(), "compileQuery");
      for (let repeat = 0; repeat < 2; repeat += 1) {
        for (const [index, id] of ids.entries()) {
          expect(read(scope(id))).toEqual(expected[index]);
        }
      }
      runOpenClawAgentWriteTransaction(({ db }) => {
        db.exec(`
          DELETE FROM transcript_events WHERE session_id = 'hot';
          DELETE FROM session_transcript_cold_archives WHERE session_id = 'cold';
          INSERT INTO transcript_events (session_id, seq, event_json, created_at)
            VALUES ('cold', 0, '{"type":"session"}', 1);
          INSERT INTO transcript_events (session_id, seq, event_json, created_at)
            VALUES ('empty', 0, '{"type":"session"}', 1);
          UPDATE session_windows SET transcript_observed_at = NULL, transcript_updated_at = 50
            WHERE session_id = 'hot';
        `);
      }, options);
      if (kind === "presence") {
        expect(ids.map((id) => read(scope(id)))).toEqual([false, true, true, false]);
      } else {
        expect(read(scope("hot"))).toEqual({ observedAt: null, updatedAt: 50 });
        expect(readTranscriptMutationAtSync(scope("hot"))).toBe(50);
      }
      expect(compile).not.toHaveBeenCalled();
    });
  },
);

it("reads each in-transaction fence advance and restores the prior pair on rollback", async () => {
  await withOpenClawTestState({ label: "prepared-transcript-rollback" }, async (state) => {
    const { database, options, scope } = createFixture(state);
    const read = () => readTranscriptMutationStateInTransaction(database, "hot");
    expect(read()).toEqual({ observedAt: 10, updatedAt: 20 });
    expect(() =>
      runOpenClawAgentWriteTransaction((current) => {
        advanceTranscriptMutationAtInTransaction(current, "hot", 1);
        expect(read()).toEqual({ observedAt: 10, updatedAt: 20 });
        advanceTranscriptMutationAtInTransaction(current, "hot", 25.9);
        expect(read()).toEqual({ observedAt: 10, updatedAt: 25 });
        advanceTranscriptMutationAtInTransaction(current, "empty", 0);
        expect(readTranscriptMutationStateInTransaction(current, "empty")).toEqual({
          observedAt: 1,
          updatedAt: 0,
        });
        advanceTranscriptMutationAtInTransaction(current, "empty", 0, { strictly: true });
        expect(readTranscriptMutationStateInTransaction(current, "empty")).toEqual({
          observedAt: 1,
          updatedAt: 2,
        });
        current.db
          .prepare("UPDATE session_windows SET transcript_observed_at = 100 WHERE session_id = ?")
          .run("hot");
        advanceTranscriptMutationAtInTransaction(current, "hot", 1, { strictly: true });
        expect(read()).toEqual({ observedAt: 100, updatedAt: 101 });
        advanceTranscriptMutationAtInTransaction(current, "hot", 1, { strictly: true });
        expect(readTranscriptMutationStateSync(scope("hot"))).toEqual({
          observedAt: 100,
          updatedAt: 102,
        });
        throw new Error("rollback fixture");
      }, options),
    ).toThrow("rollback fixture");
    expect(read()).toEqual({ observedAt: 10, updatedAt: 20 });
    expect(readTranscriptMutationAtSync(scope("hot"))).toBe(20);
    runOpenClawAgentWriteTransaction((current) => {
      advanceTranscriptMutationAtInTransaction(current, "hot", 1, { strictly: true });
    }, options);
    expect(read()).toEqual({ observedAt: 10, updatedAt: 21 });
  });
});

it("uses statement snapshots for point metadata reads and preserves a caller's WAL snapshot", async () => {
  await withOpenClawTestState({ label: "prepared-transcript-snapshot" }, async (state) => {
    const { database, scope } = createFixture(state);
    const readStats = () => readTranscriptStatsFromDatabase(database, "hot");
    const originalStats = {
      eventCount: 1,
      maxSeq: 0,
      sizeBytes: Buffer.byteLength('{"type":"session"}'),
      lastObservedMutationAtMs: 10,
      lastMutationAtMs: 20,
    };
    const exec = vi.spyOn(database.db, "exec");
    expect(hasSessionTranscriptEventsSync(scope("hot"))).toBe(true);
    expect(readTranscriptMutationStateSync(scope("hot"))).toEqual({
      observedAt: 10,
      updatedAt: 20,
    });
    expect(readStats()).toEqual(originalStats);
    expect(
      exec.mock.calls.filter(([sql]) =>
        /^(?:BEGIN|COMMIT|SAVEPOINT|RELEASE|ROLLBACK)\b/iu.test(sql),
      ),
    ).toEqual([]);
    exec.mockRestore();
    const peer = new DatabaseSync(database.path);
    try {
      runSqliteDeferredTransactionSync(database.db, () => {
        expect(readTranscriptMutationStateSync(scope("hot"))).toEqual({
          observedAt: 10,
          updatedAt: 20,
        });
        expect(readStats()).toEqual(originalStats);
        peer.exec(`
          BEGIN IMMEDIATE;
          DELETE FROM transcript_events WHERE session_id = 'hot';
          UPDATE session_windows SET transcript_observed_at = 100, transcript_updated_at = 200
            WHERE session_id = 'hot';
          COMMIT;
        `);
        expect(hasSessionTranscriptEventsSync(scope("hot"))).toBe(true);
        expect(readTranscriptMutationStateSync(scope("hot"))).toEqual({
          observedAt: 10,
          updatedAt: 20,
        });
        expect(readStats()).toEqual(originalStats);
      });
      expect(hasSessionTranscriptEventsSync(scope("hot"))).toBe(false);
      expect(readTranscriptMutationStateSync(scope("hot"))).toEqual({
        observedAt: 100,
        updatedAt: 200,
      });
      expect(readStats()).toEqual({
        eventCount: 0,
        maxSeq: 0,
        sizeBytes: 0,
        lastObservedMutationAtMs: 100,
        lastMutationAtMs: 200,
      });
    } finally {
      peer.close();
    }
  });
});

it("isolates identical session IDs by native handle and reopens without using a closed reader", async () => {
  await withOpenClawTestState({ label: "prepared-transcript-handles" }, async (state) => {
    const first = createFixture(state);
    const second = createFixture(state, "other");
    second.database.db.exec(`
      DELETE FROM transcript_events WHERE session_id = 'hot';
      UPDATE session_windows SET transcript_observed_at = 30, transcript_updated_at = 40
        WHERE session_id = 'hot';
    `);
    for (let repeat = 0; repeat < 2; repeat += 1) {
      expect(hasSessionTranscriptEventsSync(first.scope("hot"))).toBe(true);
      expect(readTranscriptMutationStateSync(first.scope("hot"))).toEqual({
        observedAt: 10,
        updatedAt: 20,
      });
      expect(hasSessionTranscriptEventsSync(second.scope("hot"))).toBe(false);
      expect(readTranscriptMutationStateSync(second.scope("hot"))).toEqual({
        observedAt: 30,
        updatedAt: 40,
      });
    }
    expect(closeOpenClawAgentDatabaseByPath(first.database.path, "main")).toBe(true);
    expect(() => readTranscriptMutationStateInTransaction(first.database, "hot")).toThrow();
    const reopened = openOpenClawAgentDatabase(first.options);
    // Compare identity without the matcher traversing closed SQLite accessors.
    expect(Object.is(reopened.db, first.database.db)).toBe(false);
    reopened.db.exec(`
      DELETE FROM transcript_events WHERE session_id = 'hot';
      UPDATE session_windows SET transcript_observed_at = 50, transcript_updated_at = 60
        WHERE session_id = 'hot';
    `);
    expect(hasSessionTranscriptEventsSync(first.scope("hot"))).toBe(false);
    expect(readTranscriptMutationStateSync(first.scope("hot"))).toEqual({
      observedAt: 50,
      updatedAt: 60,
    });
    expect(readTranscriptMutationStateSync(second.scope("hot"))).toEqual({
      observedAt: 30,
      updatedAt: 40,
    });
  });
});
