import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it as baseIt, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import * as agentDb from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import * as metadata from "./session-accessor.sqlite-metadata-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMutationAtSync } from "./session-accessor.sqlite-transcript-admitted-read.js";
import * as mutations from "./session-accessor.sqlite-transcript-state.js";
import * as statistics from "./session-accessor.sqlite-transcript-stats.js";
import { readSessionTranscriptAnchorsAsync } from "./session-transcript-anchor-read.js";
import { createTranscriptEventInserter } from "./transcript-payload.js";

const it = baseIt.extend<{ store: ReturnType<typeof createFixture> }>({
  store: async ({ task: _task }, use) =>
    withOpenClawTestState({ label: "transcript-metadata" }, ({ env }) => use(createFixture(env))),
});
afterEach(() => vi.restoreAllMocks());

const mutation = (observedAt: number | null, updatedAt: number | null) => ({
  observedAt,
  updatedAt,
});
const stats = (eventCount: number, sizeBytes: number, observedAt?: number, updatedAt?: number) => ({
  eventCount,
  maxSeq: 0,
  sizeBytes,
  ...(observedAt === undefined ? {} : { lastObservedMutationAtMs: observedAt }),
  ...(updatedAt === undefined ? {} : { lastMutationAtMs: updatedAt }),
});
const hotStats = stats(1, Buffer.byteLength('{"type":"session"}'), 10, 20);
const sessionEvent = { seq: 0, eventJson: '{"type":"session"}', createdAt: 1 };
const sessionIds = ["hot", "cold", "empty", "missing"];
const fences = [mutation(10, 20), mutation(30, 40), mutation(1, null), mutation(null, null)];

function clearHot(
  db: { exec: (sql: string) => unknown },
  observedAt: number | null,
  updatedAt: number,
) {
  db.exec(`DELETE FROM transcript_events WHERE session_id = 'hot';
    UPDATE session_windows SET transcript_observed_at = ${observedAt}, transcript_updated_at = ${updatedAt}
    WHERE session_id = 'hot';`);
}

it("batches hot, cold, missing and repeated IDs", ({ store: { batchStats } }) => {
  const expected = [hotStats, stats(1, 1, 30, 40), stats(0, 0, 1), stats(0, 0)];
  for (const count of [4, 11, 401]) {
    const ids = Array.from({ length: count }, (_, index) => sessionIds[index % sessionIds.length]!);
    const plain = ids.map((_, index) => expected[index % expected.length]);
    expect(batchStats(ids)).toEqual(plain);
    expect(batchStats(ids, true)).toEqual(
      ids.map((id, index) =>
        Object.assign({}, plain[index], {
          generation: null,
          cold: id === "cold",
          sessionKey: id === "missing" ? null : `agent:main:${id}`,
        }),
      ),
    );
  }
  expect(batchStats([])).toEqual([]);
});

it("keeps rewrite identity and bounds atomic", ({ store: { transaction, batchStats } }) => {
  const read = () => batchStats(["hot"], true)[0];
  expect(read()).toMatchObject({ generation: null, maxSeq: 0, eventCount: 1, cold: false });
  transaction((current) => {
    current.db.exec(`
        INSERT INTO transcript_rewrite_watermarks (session_id, generation, updated_at)
        VALUES ('hot', 'rewritten', 2);
      `);
    createTranscriptEventInserter(
      current.db,
      "hot",
    )({
      seq: 1,
      eventJson: '{"type":"message","id":"after-rewrite"}',
      createdAt: 2,
    });
  });
  expect(read()).toMatchObject({ generation: "rewritten", maxSeq: 1, eventCount: 2 });
  expect(() =>
    transaction((current) => {
      current.db.exec(`
          UPDATE transcript_rewrite_watermarks SET generation = 'rolled-back' WHERE session_id = 'hot';
          DELETE FROM transcript_events WHERE session_id = 'hot';
        `);
      throw new Error("rollback fixture");
    }),
  ).toThrow("rollback fixture");
  expect(read()).toMatchObject({ generation: "rewritten", maxSeq: 1, eventCount: 2 });
});

function createFixture(env: NodeJS.ProcessEnv, agentId = "main") {
  const options = { agentId, env };
  const scope = (sessionId: string) => ({
    ...options,
    sessionId,
    sessionKey: `agent:${agentId}:${sessionId}`,
  });
  // Native seeding leaves the manually assigned mutation fences free of maintenance writers.
  for (const sessionId of ["hot", "cold", "empty"]) {
    replaceSessionEntrySync(scope(sessionId), { sessionId, updatedAt: 1 });
  }
  const database = agentDb.openOpenClawAgentDatabase(options);
  createTranscriptEventInserter(database.db, "hot")(sessionEvent);
  database.db.exec(`
    INSERT INTO session_transcript_cold_archives
      (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
       archive_bytes, last_seq, archived_at, storage)
    VALUES ('cold', 'generation', 'missing.jsonl.zst', '${"0".repeat(64)}', 1, 1, 1, 0, 1, 'file');
    UPDATE session_windows SET transcript_observed_at = 10, transcript_updated_at = 20
      WHERE session_id = 'hot';
    UPDATE session_windows SET transcript_observed_at = 30, transcript_updated_at = 40
      WHERE session_id = 'cold';
  `);
  return {
    database,
    options,
    scope,
    transaction: (run: Parameters<typeof agentDb.runOpenClawAgentWriteTransaction>[0]) =>
      agentDb.runOpenClawAgentWriteTransaction(run, options),
    read: (id = "hot") =>
      mutations.readTranscriptMutationStateInTransaction(
        agentDb.openOpenClawAgentDatabase(options),
        id,
      ),
    present: (id = "hot") =>
      metadata.readSessionTranscriptMetadataInDatabase(
        agentDb.openOpenClawAgentDatabase(options),
        id,
      ).present,
    batchStats: (ids: string[], includeGeneration = false) =>
      includeGeneration
        ? statistics.readTranscriptStatsBatchFromDatabase(database, ids, {
            includeGeneration: true,
          })
        : statistics.readTranscriptStatsBatchFromDatabase(database, ids),
  };
}

it("reads hot/cold metadata off-thread without restoring payloads", async ({
  store: { scope },
}) => {
  const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  using _ = { [Symbol.dispose]: observation.restore };
  const values = [];
  for (const id of sessionIds) {
    const result = await readSessionTranscriptAnchorsAsync(scope(id), {
      entryIds: [],
      includeMetadata: true,
    });
    values.push(result.metadata);
  }
  expect(values).toEqual(fences.map((fence, index) => ({ present: index < 2, ...fence })));
  expect(
    observation.queries.filter((query) =>
      /\b(?:transcript_events|session_windows|session_transcript_cold_archives)\b/i.test(query),
    ),
  ).toEqual([]);
});

it.for(["presence", "mutation"] as const)(
  "reuses compiled %s reads with fresh bindings and rows",
  (kind, { store }) => {
    const { database, transaction, scope } = store;
    const read = kind === "presence" ? store.present : store.read;
    const expected = {
      presence: [true, true, false, false],
      mutation: fences,
    }[kind];
    const readRows = () => sessionIds.map((id) => read(id));
    expect(readRows()).toEqual(expected);
    const inserts = ["cold", "empty"].map((id) => createTranscriptEventInserter(database.db, id));
    const compile = vi.spyOn(getSessionKysely(database.db).getExecutor(), "compileQuery");
    for (let repeat = 0; repeat < 2; repeat += 1) {
      expect(readRows()).toEqual(expected);
    }
    expect(compile).not.toHaveBeenCalled();
    transaction(({ db }) => {
      clearHot(db, null, 50);
      db.exec("DELETE FROM session_transcript_cold_archives WHERE session_id = 'cold'");
      for (const insert of inserts) {
        insert(sessionEvent);
      }
    });
    // Lazy write compilation is independent of the warmed metadata readers.
    compile.mockClear();
    if (kind === "presence") {
      expect(readRows()).toEqual([false, true, true, false]);
    } else {
      expect(read("hot")).toEqual(mutation(null, 50));
      expect(readTranscriptMutationAtSync(scope("hot"))).toBe(50);
    }
    expect(compile).not.toHaveBeenCalled();
  },
);

it("reads fence advances and restores them on rollback", ({ store }) => {
  const { database, transaction, scope } = store;
  const read = (id = "hot") => mutations.readTranscriptMutationStateInTransaction(database, id);
  const advance = (id: string, value: number, strictly = false) =>
    mutations.advanceTranscriptMutationAtInTransaction(database, id, value, { strictly });
  expect(read()).toEqual(mutation(10, 20));
  expect(() =>
    transaction(({ db }) => {
      advance("hot", 1);
      expect(read()).toEqual(mutation(10, 20));
      advance("hot", 25.9);
      expect(read()).toEqual(mutation(10, 25));
      advance("empty", 0);
      expect(read("empty")).toEqual(mutation(1, 0));
      advance("empty", 0, true);
      expect(read("empty")).toEqual(mutation(1, 2));
      db.prepare(
        "UPDATE session_windows SET transcript_observed_at = 100 WHERE session_id = ?",
      ).run("hot");
      advance("hot", 1, true);
      expect(read()).toEqual(mutation(100, 101));
      advance("hot", 1, true);
      expect(store.read()).toEqual(mutation(100, 102));
      throw new Error("rollback fixture");
    }),
  ).toThrow("rollback fixture");
  expect(read()).toEqual(mutation(10, 20));
  expect(readTranscriptMutationAtSync(scope("hot"))).toBe(20);
  transaction(() => advance("hot", 1, true));
  expect(read()).toEqual(mutation(10, 21));
});

it("keeps point reads atomic and respects caller WAL snapshots", ({
  store: { database, read, present },
}) => {
  const readStats = () => statistics.readTranscriptStatsFromDatabase(database, "hot");
  const exec = vi.spyOn(database.db, "exec");
  const expectHot = () => {
    expect(read()).toEqual(mutation(10, 20));
    expect(readStats()).toEqual(hotStats);
  };
  expect(present()).toBe(true);
  expectHot();
  expect(
    exec.mock.calls.filter(([sql]) => /^(?:BEGIN|COMMIT|SAVEPOINT|RELEASE|ROLLBACK)\b/iu.test(sql)),
  ).toEqual([]);
  exec.mockRestore();
  const peer = new DatabaseSync(database.path);
  using _ = { [Symbol.dispose]: () => peer.close() };
  runSqliteDeferredTransactionSync(database.db, () => {
    expectHot();
    peer.exec("BEGIN IMMEDIATE");
    clearHot(peer, 100, 200);
    peer.exec("COMMIT");
    expect(present()).toBe(true);
    expectHot();
  });
  expect([present(), read(), readStats()]).toEqual([
    false,
    mutation(100, 200),
    stats(0, 0, 100, 200),
  ]);
});

it("isolates native handles and replaces closed readers", ({ store: first }) => {
  const second = createFixture(first.options.env, "other");
  clearHot(second.database.db, 30, 40);
  for (let repeat = 0; repeat < 2; repeat += 1) {
    expect([first.present(), first.read(), second.present(), second.read()]).toEqual([
      true,
      mutation(10, 20),
      false,
      mutation(30, 40),
    ]);
  }
  expect(agentDb.closeOpenClawAgentDatabaseByPath(first.database.path, "main")).toBe(true);
  expect(() => mutations.readTranscriptMutationStateInTransaction(first.database, "hot")).toThrow();
  const reopened = agentDb.openOpenClawAgentDatabase(first.options);
  // Compare identity without the matcher traversing closed SQLite accessors.
  expect(Object.is(reopened.db, first.database.db)).toBe(false);
  clearHot(reopened.db, 50, 60);
  expect([first.present(), first.read(), second.read()]).toEqual([
    false,
    mutation(50, 60),
    mutation(30, 40),
  ]);
});
