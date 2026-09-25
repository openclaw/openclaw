import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { sweepTombstonedCronRunRemnantsForStore } from "./cleanup-tombstones.js";
import { patchSessionEntryCore, replaceSessionEntry } from "./session-accessor.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import { deleteSessionEntryRows } from "./session-accessor.sqlite-entry-store.js";
import { planSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-lifecycle-state.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const materializedHook = vi.hoisted(() => ({
  run: undefined as (() => void) | undefined,
  /**
   * Awaited at the entry of the sweep's materialization await, so a test can
   * hold the sweep inside the encoding window and observe what else this
   * process can still do. Only the encoder's duration becomes controllable:
   * the writer queue, lifecycle admission and reclamation admission around it
   * all stay real, which is what makes the scheduling assertion meaningful.
   */
  beforeRun: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    // Must await: materialization is worker-backed and async, and the hook
    // exists to inject a late live reference *after* encoding completes.
    // Firing it against the unresolved promise would invert the ordering the
    // abandoned-delete test asserts.
    materializeSessionStateDeletePlans: async (
      plans: Parameters<typeof actual.materializeSessionStateDeletePlans>[0],
    ) => {
      await materializedHook.beforeRun?.();
      const materialized = await actual.materializeSessionStateDeletePlans(plans);
      materializedHook.run?.();
      return materialized;
    },
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 7, 1, 0, 0, 0);
const CRON_RUN_KEY = "agent:main:cron:job-1:run:run-1";

/**
 * Whether `promise` settles within a bounded number of event-loop turns.
 *
 * Turn-bounded rather than time-bounded on purpose. A write queued behind a
 * held store-writer lane cannot settle in any number of turns while its holder
 * is parked, and an admitted one settles within a few, so the verdict is a
 * property of the scheduling rather than of how fast this host happens to be.
 */
async function settlesWithinEventLoopTurns(
  promise: Promise<unknown>,
  turns = 500,
): Promise<"settled" | "pending"> {
  const observed = { settled: false };
  const observe = () => {
    observed.settled = true;
  };
  void promise.then(observe, observe);
  for (let turn = 0; turn < turns && !observed.settled; turn += 1) {
    await setImmediate();
  }
  return observed.settled ? "settled" : "pending";
}

type SessionStoreReadMetrics = { rows: number; statements: number };

type InstrumentedStatement = {
  sourceSQL?: string;
  all: (...parameters: never[]) => unknown[];
  iterate: (...parameters: never[]) => IterableIterator<unknown>;
};

/**
 * Counts the session-store rows real SQLite statements return while `run`
 * executes.
 *
 * Nothing in the production path is replaced: `node:sqlite` still prepares,
 * binds and steps every statement the sweep issues, and this only observes the
 * rows leaving the driver. That keeps the measurement a property of the queries
 * themselves rather than of a stand-in store.
 */
async function measureSessionStoreReads<T>(
  run: () => Promise<T>,
): Promise<{ result: T; metrics: SessionStoreReadMetrics }> {
  const metrics: SessionStoreReadMetrics = { rows: 0, statements: 0 };
  const prototype = StatementSync.prototype as unknown as InstrumentedStatement;
  const originalAll = prototype.all;
  const originalIterate = prototype.iterate;
  const readsSessionStore = (statement: InstrumentedStatement) =>
    /session_nodes|session_windows/.test(statement.sourceSQL ?? "");
  prototype.all = function all(this: InstrumentedStatement, ...parameters: never[]) {
    const rows = originalAll.apply(this, parameters);
    if (readsSessionStore(this)) {
      metrics.statements += 1;
      metrics.rows += rows.length;
    }
    return rows;
  };
  prototype.iterate = function iterate(this: InstrumentedStatement, ...parameters: never[]) {
    const iterator = originalIterate.apply(this, parameters);
    if (!readsSessionStore(this)) {
      return iterator;
    }
    metrics.statements += 1;
    // `yield*` forwards return()/throw() to the driver iterator, so the
    // production error and early-exit paths keep their cleanup.
    return (function* counted() {
      for (const row of iterator) {
        metrics.rows += 1;
        yield row;
      }
    })();
  };
  try {
    return { result: await run(), metrics };
  } finally {
    prototype.all = originalAll;
    prototype.iterate = originalIterate;
  }
}

/**
 * Every reference query carries this JSON path, in both the narrowed and the
 * unnarrowed form, so it identifies the statement across revisions of the
 * predicate itself.
 */
const REFERENCE_QUERY_MARKER = "$.previousSessionId";

type ReferenceScanMetrics = {
  /** Reference statements SQLite actually executed. */
  scans: number;
  /** Rows SQLite examined and mostly rejected inside those statements. */
  rowsExamined: number;
};

/**
 * Counts the work SQLite performs inside the reference query rather than the
 * rows it hands back.
 *
 * `json_valid` is evaluated once per row the reference predicate examines and
 * cannot match on the narrowed id, so replacing it with a counting
 * implementation turns "rows examined and rejected inside SQLite" into a
 * number. The verdict is delegated to a separate connection that does not carry
 * the override, so the production predicate keeps its exact semantics; only the
 * count is added. Calls are attributed to the statement currently stepping, so
 * `json_valid` in unrelated projections cannot inflate the measurement.
 */
async function measureReferenceScanWork<T>(
  run: () => Promise<T>,
): Promise<{ result: T; metrics: ReferenceScanMetrics }> {
  const metrics: ReferenceScanMetrics = { scans: 0, rowsExamined: 0 };
  const steppingSql: string[] = [];
  const statementPrototype = StatementSync.prototype as unknown as InstrumentedStatement;
  const databasePrototype = DatabaseSync.prototype as unknown as {
    prepare: (...parameters: never[]) => StatementSync;
    function: (
      name: string,
      options: { deterministic: boolean },
      implementation: (...parameters: never[]) => unknown,
    ) => void;
  };
  const originalAll = statementPrototype.all;
  const originalIterate = statementPrototype.iterate;
  const originalPrepare = databasePrototype.prepare;
  const oracle = new DatabaseSync(":memory:");
  const oracleVerdict = oracle.prepare("SELECT json_valid(?) AS valid");
  const instrumented = new WeakSet<object>();
  const isReferenceQuery = (statement: InstrumentedStatement) =>
    (statement.sourceSQL ?? "").includes(REFERENCE_QUERY_MARKER);
  const countJsonValid = (value: unknown) => {
    if (steppingSql.at(-1)?.includes(REFERENCE_QUERY_MARKER)) {
      metrics.rowsExamined += 1;
    }
    return ((oracleVerdict.get(value as never) as { valid?: unknown } | undefined)?.valid ??
      0) as number;
  };
  databasePrototype.prepare = function prepare(this: object, ...parameters: never[]) {
    if (!instrumented.has(this)) {
      instrumented.add(this);
      (this as unknown as typeof databasePrototype).function(
        "json_valid",
        { deterministic: true },
        countJsonValid as (...parameters: never[]) => unknown,
      );
    }
    return originalPrepare.apply(this as never, parameters);
  };
  statementPrototype.all = function all(this: InstrumentedStatement, ...parameters: never[]) {
    if (!isReferenceQuery(this)) {
      return originalAll.apply(this, parameters);
    }
    metrics.scans += 1;
    steppingSql.push(this.sourceSQL ?? "");
    try {
      return originalAll.apply(this, parameters);
    } finally {
      steppingSql.pop();
    }
  };
  statementPrototype.iterate = function iterate(
    this: InstrumentedStatement,
    ...parameters: never[]
  ) {
    const iterator = originalIterate.apply(this, parameters);
    if (!isReferenceQuery(this)) {
      return iterator;
    }
    metrics.scans += 1;
    const sourceSQL = this.sourceSQL ?? "";
    // Attribute per step, not per statement: the driver only runs the predicate
    // inside next(), and unrelated queries can interleave between yields.
    const stepped: IterableIterator<unknown> = {
      [Symbol.iterator]: () => stepped,
      next: () => {
        steppingSql.push(sourceSQL);
        try {
          return iterator.next();
        } finally {
          steppingSql.pop();
        }
      },
      return: (value?: unknown) => iterator.return?.(value) ?? { done: true, value },
      throw: (error?: unknown) => {
        if (iterator.throw) {
          return iterator.throw(error);
        }
        throw error;
      },
    };
    return stepped;
  };
  try {
    return { result: await run(), metrics };
  } finally {
    statementPrototype.all = originalAll;
    statementPrototype.iterate = originalIterate;
    databasePrototype.prepare = originalPrepare;
    oracle.close();
  }
}

describe("sweepTombstonedCronRunRemnants", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-tombstone-sweep-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(async () => {
    materializedHook.run = undefined;
    materializedHook.beforeRun = undefined;
    delete process.env.OPENCLAW_STATE_DIR;
    // `closeOpenClawAgentDatabasesForTest` only *starts* asynchronous resource
    // retirement, so the temp-dir hook registered above could remove the
    // databases while reclamation workers still held their durable leases,
    // which surfaced as an ENOENT teardown failure after every assertion had
    // passed. `cleanupSessionStateForTest` is the existing awaited lifecycle
    // owner: it drains the store writer queues and closes the agent and shared
    // state handles before this hook returns. Vitest runs `afterEach` hooks in
    // reverse registration order, so this one settles before the tracker's
    // removal runs.
    await cleanupSessionStateForTest({ stateDir: tempDir });
    closeOpenClawAgentDatabasesForTest();
  });

  function openDatabase() {
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    if (!databasePath) {
      throw new Error("expected sqlite database path");
    }
    return openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
  }

  /**
   * Writes one entry the way `replaceSessionEntry` does, optionally without the
   * background maintenance kick an ordinary entry write schedules.
   *
   * Every entry write ends in `kickSessionEntryMaintenanceAfterWrite`, which
   * queues a coalesced `setImmediate` maintenance pass. That pass reclaims
   * through a Worker (`forceInProcess: false`), so it opens the store on its
   * own connection and commits. Landing that commit inside a measured sweep is
   * indistinguishable, from the sweeping connection, from an external writer
   * creating a reference, so the reference batch is correctly dropped and every
   * remaining candidate falls back to an unbatched read. That is the right
   * product behavior and stays under test in the late-owner cases; it just
   * cannot be allowed to arrive from the fixture's own seeding while the thing
   * being measured is how much work one sweep performs.
   */
  async function writeSessionEntry(
    key: string,
    entry: { sessionId: string; updatedAt: number },
    options: { skipMaintenance?: boolean } = {},
  ): Promise<void> {
    await patchSessionEntryCore({ sessionKey: key, storePath }, () => entry, {
      fallbackEntry: entry,
      replaceEntry: true,
      ...(options.skipMaintenance ? { skipMaintenance: true } : {}),
    });
  }

  async function seedCanonicalPlaceholder(params: {
    ageMs?: number;
    key?: string;
    sessionId?: string;
    skipMaintenance?: boolean;
  }): Promise<string> {
    const key = params.key ?? CRON_RUN_KEY;
    const sessionId = params.sessionId ?? "cron-session";
    await writeSessionEntry(
      key,
      { sessionId, updatedAt: NOW_MS },
      { skipMaintenance: params.skipMaintenance ?? false },
    );
    replaceTranscriptEventsSync({ sessionKey: key, sessionId, storePath }, [
      { type: "session", id: sessionId, content: "cron run transcript" },
    ]);
    const database = openDatabase();
    deleteSessionEntryRows(database, key);
    const updatedAt = NOW_MS - (params.ageMs ?? 20 * DAY_MS);
    const db = getSessionKysely(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_windows")
        .set({ updated_at: updatedAt })
        .where("session_key", "=", key),
    );
    executeSqliteQuerySync(
      database.db,
      db.updateTable("session_nodes").set({ updated_at: updatedAt }).where("session_key", "=", key),
    );
    executeSqliteQuerySync(
      database.db,
      db.updateTable("session_nodes").set({ entry_valid: -1 }).where("session_key", "=", key),
    );
    return sessionId;
  }

  function sweep(params: {
    agentId?: string;
    sharedOwnerAgentIds?: readonly string[];
    dryRun: boolean;
    olderThanMs?: number;
  }) {
    return sweepTombstonedCronRunRemnantsForStore({
      target: {
        agentId: params.agentId ?? "main",
        storePath,
        ...(params.sharedOwnerAgentIds ? { sharedOwnerAgentIds: params.sharedOwnerAgentIds } : {}),
      },
      retentionMs: params.olderThanMs ?? 15 * DAY_MS,
      dryRun: params.dryRun,
      nowMs: NOW_MS,
    });
  }

  /**
   * Same shape as a canonical placeholder except `entry_json`, which the
   * canonical predicate requires to be exactly "{}". This is the row class the
   * superseded fix/session-node-orphan-cleanup branch reaped and the canonical
   * sweep deliberately preserves.
   */
  async function seedUnidentifiedPlaceholder(params: { ageMs?: number } = {}): Promise<string> {
    const sessionId = await seedCanonicalPlaceholder({ ageMs: params.ageMs });
    const database = openDatabase();
    const db = getSessionKysely(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_nodes")
        .set({ entry_json: JSON.stringify({ delivery: { kind: "none" } }) })
        .where("session_key", "=", CRON_RUN_KEY),
    );
    return sessionId;
  }

  function countRows(
    table: "session_nodes" | "session_windows" | "transcript_events",
    column: "session_key" | "session_id",
    value: string,
  ): number {
    const database = openDatabase();
    const db = getSessionKysely(database.db);
    return executeSqliteQuerySync(
      database.db,
      db.selectFrom(table).select(column).where(column, "=", value),
    ).rows.length;
  }

  /** Canonical archive rows committed and published by a completed sweep. */
  function archiveRows(sessionId: string): { archive_name: string; published_at: number | null }[] {
    const database = openDatabase();
    const db = getSessionKysely(database.db);
    try {
      return executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_transcript_archives")
          .select(["archive_name", "published_at"])
          .where("session_id", "=", sessionId),
      ).rows as { archive_name: string; published_at: number | null }[];
    } catch {
      return [];
    }
  }

  function archiveNames(sessionId: string): string[] {
    try {
      return fs
        .readdirSync(path.dirname(storePath))
        .filter((name) => name.startsWith(`${sessionId}.jsonl.deleted.`));
    } catch {
      return [];
    }
  }

  it("archives and deletes an expired canonical cron-run placeholder", async () => {
    const sessionId = await seedCanonicalPlaceholder({});
    const database = openDatabase();
    expect(
      database.db
        .prepare(
          "SELECT current_session_id, entry_json, entry_valid FROM session_nodes WHERE session_key = ?",
        )
        .get(CRON_RUN_KEY),
    ).toEqual({
      current_session_id: sessionId,
      entry_json: "{}",
      entry_valid: -1,
    });

    await expect(sweep({ dryRun: true })).resolves.toMatchObject({
      candidates: 1,
      removedNodes: 0,
      sweptTranscriptStates: 0,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 1,
      removedNodes: 1,
      sweptTranscriptStates: 1,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(0);
    expect(countRows("session_windows", "session_key", CRON_RUN_KEY)).toBe(0);
    expect(countRows("transcript_events", "session_id", sessionId)).toBe(0);
    const archives = archiveRows(sessionId);
    expect(archives).toHaveLength(1);
    expect(archives[0]?.published_at).toEqual(expect.any(Number));
    expect(archiveNames(sessionId)).toEqual([archives[0]?.archive_name]);

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 0,
      removedNodes: 0,
      sweptTranscriptStates: 0,
    });
    expect(archiveRows(sessionId)).toHaveLength(1);
  });

  it("preserves another logical agent's placeholder in a shared SQLite store", async () => {
    storePath = path.join(tempDir, "shared.sqlite");
    const opsKey = "agent:ops:cron:job-2:run:run-2";
    const mainSessionId = await seedCanonicalPlaceholder({});
    const opsSessionId = await seedCanonicalPlaceholder({
      key: opsKey,
      sessionId: "ops-cron-session",
    });

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 1,
      removedNodes: 1,
      sweptTranscriptStates: 1,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(0);
    expect(countRows("transcript_events", "session_id", mainSessionId)).toBe(0);
    expect(countRows("session_nodes", "session_key", opsKey)).toBe(1);
    expect(countRows("session_windows", "session_key", opsKey)).toBe(1);
    expect(countRows("transcript_events", "session_id", opsSessionId)).toBe(1);
    expect(archiveRows(opsSessionId)).toHaveLength(0);
  });

  it("cleans a selected non-owner agent in a main-owned shared SQLite store", async () => {
    storePath = path.join(tempDir, "shared.sqlite");
    const opsKey = "agent:ops:cron:job-2:run:run-2";
    const mainSessionId = await seedCanonicalPlaceholder({});
    const opsSessionId = await seedCanonicalPlaceholder({
      key: opsKey,
      sessionId: "ops-cron-session",
    });

    await expect(sweep({ agentId: "ops", dryRun: false })).resolves.toMatchObject({
      candidates: 1,
      removedNodes: 1,
      sweptTranscriptStates: 1,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("session_windows", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("transcript_events", "session_id", mainSessionId)).toBe(1);
    expect(countRows("session_nodes", "session_key", opsKey)).toBe(0);
    expect(countRows("session_windows", "session_key", opsKey)).toBe(0);
    expect(countRows("transcript_events", "session_id", opsSessionId)).toBe(0);
    expect(archiveRows(opsSessionId)).toHaveLength(1);
  });

  it("sweeps every selected owner of a shared SQLite store", async () => {
    storePath = path.join(tempDir, "shared.sqlite");
    const opsKey = "agent:ops:cron:job-2:run:run-2";
    const mainSessionId = await seedCanonicalPlaceholder({});
    const opsSessionId = await seedCanonicalPlaceholder({
      key: opsKey,
      sessionId: "ops-cron-session",
    });

    // --all-agents collapses both logical agents onto this one physical store,
    // so the sweep receives the whole selected owner set instead of one agent.
    await expect(
      sweep({ sharedOwnerAgentIds: ["main", "ops"], dryRun: false }),
    ).resolves.toMatchObject({
      candidates: 2,
      removedNodes: 2,
      sweptTranscriptStates: 2,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(0);
    expect(countRows("session_windows", "session_key", CRON_RUN_KEY)).toBe(0);
    expect(countRows("transcript_events", "session_id", mainSessionId)).toBe(0);
    expect(countRows("session_nodes", "session_key", opsKey)).toBe(0);
    expect(countRows("session_windows", "session_key", opsKey)).toBe(0);
    expect(countRows("transcript_events", "session_id", opsSessionId)).toBe(0);
    expect(archiveRows(mainSessionId)).toHaveLength(1);
    expect(archiveRows(opsSessionId)).toHaveLength(1);
  });

  it("ignores unselected owners when a shared-store sweep names a subset", async () => {
    storePath = path.join(tempDir, "shared.sqlite");
    const opsKey = "agent:ops:cron:job-2:run:run-2";
    const auditKey = "agent:audit:cron:job-3:run:run-3";
    const mainSessionId = await seedCanonicalPlaceholder({});
    const opsSessionId = await seedCanonicalPlaceholder({
      key: opsKey,
      sessionId: "ops-cron-session",
    });
    const auditSessionId = await seedCanonicalPlaceholder({
      key: auditKey,
      sessionId: "audit-cron-session",
    });

    await expect(
      sweep({ agentId: "ops", sharedOwnerAgentIds: ["ops", "main"], dryRun: false }),
    ).resolves.toMatchObject({
      candidates: 2,
      removedNodes: 2,
      sweptTranscriptStates: 2,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(0);
    expect(countRows("session_nodes", "session_key", opsKey)).toBe(0);
    expect(countRows("transcript_events", "session_id", mainSessionId)).toBe(0);
    expect(countRows("transcript_events", "session_id", opsSessionId)).toBe(0);
    expect(countRows("session_nodes", "session_key", auditKey)).toBe(1);
    expect(countRows("session_windows", "session_key", auditKey)).toBe(1);
    expect(countRows("transcript_events", "session_id", auditSessionId)).toBe(1);
    expect(archiveRows(auditSessionId)).toHaveLength(0);
  });

  it("uses the newest owned window timestamp for the retention gate", async () => {
    const sessionId = await seedCanonicalPlaceholder({});
    const database = openDatabase();
    const db = getSessionKysely(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_windows")
        .set({ updated_at: NOW_MS - DAY_MS })
        .where("session_id", "=", sessionId),
    );

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 0,
      removedNodes: 0,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("transcript_events", "session_id", sessionId)).toBe(1);
  });

  it("preserves the whole placeholder when another live entry references its generation", async () => {
    const sessionId = await seedCanonicalPlaceholder({});
    await replaceSessionEntry(
      { sessionKey: "agent:main:direct:survivor", storePath },
      {
        previousSessionId: sessionId,
        sessionId: "survivor-session",
        updatedAt: NOW_MS,
      },
    );

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 1,
      removedNodes: 0,
      sweptTranscriptStates: 0,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("session_windows", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("transcript_events", "session_id", sessionId)).toBe(1);
    expect(archiveNames(sessionId)).toEqual([]);
  });

  it("removes a new archive when final revalidation finds a late live reference", async () => {
    const sessionId = await seedCanonicalPlaceholder({});
    materializedHook.run = () => {
      const database = openDatabase();
      const db = getSessionKysely(database.db);
      executeSqliteQuerySync(
        database.db,
        db.insertInto("session_nodes").values({
          session_key: "agent:main:direct:late-reference",
          current_session_id: sessionId,
          entry_json: "{}",
          updated_at: NOW_MS,
        }),
      );
    };

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 1,
      removedNodes: 0,
      sweptTranscriptStates: 0,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("session_windows", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("transcript_events", "session_id", sessionId)).toBe(1);
    expect(archiveNames(sessionId)).toEqual([]);
  });

  it("writes no archive row when final revalidation finds a late live reference", async () => {
    const sessionId = await seedCanonicalPlaceholder({});
    const database = openDatabase();
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveDirectory: path.dirname(storePath),
      archiveTranscript: true,
      database,
      reason: "deleted",
      referencedSessionIds: new Set(),
      sessionId,
    });
    expect(plan).not.toBeNull();
    // Materialization only ENCODES; it must not persist or publish anything.
    await materializeSessionStateDeletePlans(plan ? [plan] : []);
    expect(archiveRows(sessionId)).toHaveLength(0);
    expect(archiveNames(sessionId)).toEqual([]);
    materializedHook.run = () => {
      const currentDatabase = openDatabase();
      const db = getSessionKysely(currentDatabase.db);
      executeSqliteQuerySync(
        currentDatabase.db,
        db.insertInto("session_nodes").values({
          session_key: "agent:main:direct:late-reference",
          current_session_id: sessionId,
          entry_json: "{}",
          updated_at: NOW_MS,
        }),
      );
    };

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 1,
      removedNodes: 0,
      sweptTranscriptStates: 0,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("transcript_events", "session_id", sessionId)).toBe(1);
    // The canonical row is inserted inside the deletion transaction, so an
    // abandoned delete rolls it back and the deferred publish pass never sees
    // it. No archive may describe a session that still exists.
    expect(archiveRows(sessionId)).toHaveLength(0);
    expect(archiveNames(sessionId)).toEqual([]);
  });

  it("preserves malformed and non-cron rows instead of treating parser failure as debris", async () => {
    const cases = [
      {
        key: "agent:main:cron:job-2:run:invalid-json",
        entryJson: "{",
        entryValid: -1,
        currentSessionId: "invalid-json",
      },
      {
        key: "agent:main:cron:job-2:run:invalid-marker",
        entryJson: "{}",
        entryValid: 0,
        currentSessionId: "invalid-marker",
      },
      {
        key: "agent:main:cron:job-2:run:missing-window",
        entryJson: "{}",
        entryValid: -1,
        currentSessionId: "different-session",
      },
      {
        key: "agent:main:direct:not-cron",
        entryJson: "{}",
        entryValid: -1,
        currentSessionId: "not-cron",
      },
    ] as const;

    for (const testCase of cases) {
      const sessionId = await seedCanonicalPlaceholder({
        key: testCase.key,
        sessionId: testCase.key.split(":").at(-1),
      });
      const database = openDatabase();
      const db = getSessionKysely(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("session_nodes")
          .set({
            current_session_id: testCase.currentSessionId,
            entry_json: testCase.entryJson,
          })
          .where("session_key", "=", testCase.key),
      );
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("session_nodes")
          .set({ entry_valid: testCase.entryValid })
          .where("session_key", "=", testCase.key),
      );
      expect(countRows("transcript_events", "session_id", sessionId)).toBe(1);
    }

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 0,
      removedNodes: 0,
      sweptTranscriptStates: 0,
    });
    for (const testCase of cases) {
      expect(countRows("session_nodes", "session_key", testCase.key)).toBe(1);
      expect(countRows("session_windows", "session_key", testCase.key)).toBe(1);
    }
  });

  it("preserves an unidentifiable aged cron row by default", async () => {
    await seedUnidentifiedPlaceholder();

    const result = await sweep({ dryRun: true });

    expect(result).toMatchObject({ candidates: 0 });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);
  });

  async function seedBacklog(placeholders: number, label: string): Promise<void> {
    storePath = path.join(tempDir, `${label}.sqlite`);
    for (let index = 0; index < placeholders; index += 1) {
      await seedCanonicalPlaceholder({
        key: `agent:main:cron:job-${index}:run:run-${index}`,
        sessionId: `cron-session-${index}`,
        // Scaling fixtures only: keep the seeding's own background maintenance
        // out of the window whose database work is being measured.
        skipMaintenance: true,
      });
    }
  }

  it("keeps per-placeholder store reads flat as the backlog grows", async () => {
    // Apply used to re-list every node and window per candidate, so the reads a
    // sweep performed grew with candidates x store size. Measure the real driver
    // at two backlog sizes and require the per-candidate cost to stay flat.
    const measure = async (placeholders: number, label: string) => {
      await seedBacklog(placeholders, label);
      const { result, metrics } = await measureSessionStoreReads(() => sweep({ dryRun: false }));
      expect(result).toMatchObject({
        candidates: placeholders,
        removedNodes: placeholders,
        sweptTranscriptStates: placeholders,
      });
      return metrics.rows / placeholders;
    };

    const smallBacklog = await measure(3, "backlog-small");
    const largeBacklog = await measure(12, "backlog-large");

    // Quadratic revalidation put the 12-placeholder store far above the
    // 3-placeholder per-candidate cost; bounded queries keep the ratio ~1.
    expect(largeBacklog).toBeLessThanOrEqual(smallBacklog * 1.5);
  });

  /**
   * A backlog next to an equal number of live non-cron sessions.
   *
   * The live rows are what makes the scan cost visible: they can never match a
   * candidate id, so the reference predicate has to examine and reject each of
   * them on every pass. A store made only of candidates would let the narrowed
   * id match short-circuit and report almost no work either way.
   */
  async function seedMixedBacklog(placeholders: number, label: string): Promise<void> {
    await seedBacklog(placeholders, label);
    for (let index = 0; index < placeholders; index += 1) {
      await writeSessionEntry(
        `agent:main:live-${index}`,
        { sessionId: `live-session-${index}`, updatedAt: NOW_MS },
        { skipMaintenance: true },
      );
    }
  }

  it("keeps the reference work SQLite performs flat as the backlog grows", async () => {
    // The returned-row measurement above cannot see this cost: narrowing the
    // projection still left every reference boundary examining the whole node
    // table, once per generation, three times per candidate. Measure the work
    // SQLite performs inside the reference statements and require the
    // per-candidate cost to stay flat as the store grows.
    const measure = async (placeholders: number, label: string) => {
      await seedMixedBacklog(placeholders, label);
      const { result, metrics } = await measureReferenceScanWork(() => sweep({ dryRun: false }));
      expect(result).toMatchObject({
        candidates: placeholders,
        removedNodes: placeholders,
        sweptTranscriptStates: placeholders,
      });
      return metrics;
    };

    const smallBacklog = await measure(3, "scan-small");
    const largeBacklog = await measure(12, "scan-large");

    // Guard the measurement itself: a run that stopped issuing the reference
    // statement, or stopped reaching `json_valid`, would pass vacuously.
    expect(smallBacklog.scans).toBeGreaterThan(0);
    expect(smallBacklog.rowsExamined).toBeGreaterThan(0);
    expect(largeBacklog.rowsExamined).toBeGreaterThan(0);
    // Reference analysis is amortized across bounded batches, so the number of
    // reference statements a sweep issues no longer scales with its candidates.
    expect(largeBacklog.scans).toBeLessThanOrEqual(3);
    expect(largeBacklog.rowsExamined / 12).toBeLessThanOrEqual(
      (smallBacklog.rowsExamined / 3) * 1.5,
    );
    // Absolute bound: one sweep may examine the 24-row store a small constant
    // number of times, never candidate-count times.
    expect(largeBacklog.rowsExamined).toBeLessThanOrEqual(24 * 3);
  });

  it("re-reads references for a later candidate when a late owner appears mid-batch", async () => {
    // Batched analysis must never authorize a stale delete. A reference created
    // after the batch's single pass has to be found by the owning candidate's
    // own in-transaction check rather than answered from a memo taken before it
    // existed, whichever position that candidate holds in the batch.
    storePath = path.join(tempDir, "batch-freshness.sqlite");
    const sessionIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      sessionIds.push(
        await seedCanonicalPlaceholder({
          key: `agent:main:cron:job-${index}:run:run-${index}`,
          sessionId: `cron-session-${index}`,
        }),
      );
    }
    const lateReferenced = sessionIds[2] ?? "";
    materializedHook.run = () => {
      // Only the first reclaim in the batch injects it, so the reference lands
      // after the batch pass and before the candidate that owns it is reached.
      materializedHook.run = undefined;
      const database = openDatabase();
      const db = getSessionKysely(database.db);
      executeSqliteQuerySync(
        database.db,
        db.insertInto("session_nodes").values({
          session_key: "agent:main:direct:late-batch-reference",
          current_session_id: lateReferenced,
          entry_json: "{}",
          updated_at: NOW_MS,
        }),
      );
    };

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 3,
      removedNodes: 2,
      sweptTranscriptStates: 2,
    });
    expect(countRows("session_nodes", "session_key", "agent:main:cron:job-2:run:run-2")).toBe(1);
    expect(countRows("session_windows", "session_key", "agent:main:cron:job-2:run:run-2")).toBe(1);
    expect(countRows("transcript_events", "session_id", lateReferenced)).toBe(1);
    expect(archiveNames(lateReferenced)).toEqual([]);
  });

  it("keeps a placeholder whose own key holds a work admission", async () => {
    const sessionId = await seedCanonicalPlaceholder({});
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [CRON_RUN_KEY],
      assertAllowed: () => {},
    });

    try {
      await expect(sweep({ dryRun: false })).resolves.toMatchObject({
        candidates: 1,
        removedNodes: 0,
        sweptTranscriptStates: 0,
      });
    } finally {
      admission.release();
    }
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("session_windows", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("transcript_events", "session_id", sessionId)).toBe(1);
    expect(archiveNames(sessionId)).toEqual([]);
  });

  it("admits an unrelated same-process write while archive encoding is pending", async () => {
    const sessionId = await seedCanonicalPlaceholder({});
    const unrelatedKey = "agent:main:direct:unrelated-writer";
    let signalEncodingEntered = () => {};
    const encodingEntered = new Promise<void>((resolve) => {
      signalEncodingEntered = resolve;
    });
    let releaseEncoding = () => {};
    const encodingReleased = new Promise<void>((resolve) => {
      releaseEncoding = resolve;
    });
    materializedHook.beforeRun = async () => {
      signalEncodingEntered();
      await encodingReleased;
    };

    const sweepResult = sweep({ dryRun: false });
    await encodingEntered;
    // The sweep is parked exactly where a real one spends nearly all of its
    // wall clock: awaiting transcript encoding for one candidate. Encoding runs
    // off-thread, so the only thing that could stall an unrelated write here is
    // the store writer queue — which is process-local and FIFO, and which this
    // sweep must therefore have released before awaiting.
    const unrelatedWrite = replaceSessionEntry(
      { sessionKey: unrelatedKey, storePath },
      { sessionId: "unrelated-session", updatedAt: NOW_MS },
    );
    let admission: "settled" | "pending";
    try {
      admission = await settlesWithinEventLoopTurns(unrelatedWrite);
    } finally {
      releaseEncoding();
      await Promise.allSettled([unrelatedWrite, sweepResult]);
    }

    expect(admission).toBe("settled");
    await expect(unrelatedWrite).resolves.toMatchObject({ sessionId: "unrelated-session" });
    expect(countRows("session_nodes", "session_key", unrelatedKey)).toBe(1);
    // The candidate still completes normally: releasing the writer around
    // encoding must not cost the sweep its deletion or its archive.
    await expect(sweepResult).resolves.toMatchObject({
      candidates: 1,
      removedNodes: 1,
      sweptTranscriptStates: 1,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(0);
    expect(countRows("transcript_events", "session_id", sessionId)).toBe(0);
    expect(archiveNames(sessionId)).toHaveLength(1);
  });

  it("keeps a placeholder whose generation id holds a work admission", async () => {
    const sessionId = await seedCanonicalPlaceholder({});
    // Admissions carry either the live session key or the backing generation id;
    // this is the id-shaped half, which the narrowed probe answers in memory.
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionId],
      assertAllowed: () => {},
    });

    try {
      await expect(sweep({ dryRun: false })).resolves.toMatchObject({
        candidates: 1,
        removedNodes: 0,
        sweptTranscriptStates: 0,
      });
    } finally {
      admission.release();
    }
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("session_windows", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("transcript_events", "session_id", sessionId)).toBe(1);
    expect(archiveNames(sessionId)).toEqual([]);
  });
});
