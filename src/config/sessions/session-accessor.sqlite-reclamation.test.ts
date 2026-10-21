import assert from "node:assert/strict";
import { once } from "node:events";
import { symlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { isMainThread, threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runWithDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import { flushLogger, setLoggerOverride } from "../../logging/logger.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import * as agentDb from "../../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import * as stateDb from "../../state/openclaw-state-db.js";
import type {
  SessionAccessScope,
  SqliteSessionReclamationDiagnostics as Diagnostics,
} from "./session-accessor.sqlite-contract.js";
import {
  loadSessionEntry,
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import type { SqliteSessionReclamationPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { withSqliteSessionPageReclamation } from "./session-accessor.sqlite-page-reclamation.js";
import { observeReclamationWorkers } from "./session-accessor.sqlite-reclamation-reuse.test-support.js";
import { runSqliteSessionReclamation as reclaim } from "./session-accessor.sqlite-reclamation-run.js";
import {
  createLifecycleArtifactReclamationPlan,
  resolveSessionReclamationDatabaseOptions,
} from "./session-accessor.sqlite-reclamation.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import type { SqliteWorkerWriteAdmission } from "./session-accessor.sqlite-worker-request.js";
import { reclaimSqliteFreePages } from "./session-history-archive-pruning.js";

const executionContext = { pid: process.pid, threadId, isMainThread };
const removedArtifact = { kind: "lifecycle-artifacts", value: { removedEntries: 1 } };
const hooks = vi.hoisted(() => ({
  beforeWriteAdmission: undefined as (() => Promise<void>) | undefined,
  afterWriteAdmission: undefined as (() => Promise<void>) | undefined,
  failWorkerLog: false,
  workerLogAttempts: 0,
}));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const logger = actual.createSubsystemLogger(name);
      const warn = logger.warn;
      logger.warn = (message, meta) => {
        if (
          message === "slow SQLite reclamation Worker operation" ||
          message === "SQLite reclamation Worker failed"
        ) {
          hooks.workerLogAttempts += 1;
          if (hooks.failWorkerLog) {
            throw new Error("synthetic log transport failure");
          }
        }
        warn(message, meta);
      };
      return logger;
    },
  };
});
vi.mock("./session-accessor.sqlite-reclamation-worker.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./session-accessor.sqlite-reclamation-worker.js")>();
  return {
    ...actual,
    withSqliteReclamationWorker: ((options, claim, run, assertRequestCurrent, signal) =>
      actual.withSqliteReclamationWorker(
        options,
        claim,
        async (worker) => {
          const observeAdmission =
            <T>(withWriteAdmission: SqliteWorkerWriteAdmission<T>): SqliteWorkerWriteAdmission<T> =>
            async (runAdmitted, diagnostics) => {
              await hooks.beforeWriteAdmission?.();
              return withWriteAdmission(async (refusal) => {
                await hooks.afterWriteAdmission?.();
                return await runAdmitted(refusal);
              }, diagnostics);
            };
          const originalPrepare = worker.prepare.bind(worker);
          const prepareSpy = vi.spyOn(worker, "prepare").mockImplementation((params) =>
            originalPrepare({
              ...params,
              withWriteAdmission: observeAdmission(params.withWriteAdmission),
            }),
          );
          const originalRun = worker.run.bind(worker);
          const spy = vi.spyOn(worker, "run").mockImplementation((params) =>
            originalRun({
              ...params,
              withWriteAdmission:
                params.withWriteAdmission && observeAdmission(params.withWriteAdmission),
            }),
          );
          try {
            return await run(worker);
          } finally {
            spy.mockRestore();
            prepareSpy.mockRestore();
          }
        },
        assertRequestCurrent,
        signal,
      )) satisfies typeof actual.withSqliteReclamationWorker,
  };
});
afterEach(() => {
  hooks.beforeWriteAdmission = undefined;
  hooks.afterWriteAdmission = undefined;
  hooks.failWorkerLog = false;
  hooks.workerLogAttempts = 0;
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await flushLogger();
  setLoggerOverride(null);
  await agentDb.closeOpenClawAgentDatabasesAsync();
  agentDb.closeOpenClawAgentDatabasesForTest();
  await stateDb.closeOpenClawStateDatabaseAsync();
});

function createFixture(alias = false) {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-reclamation-writers-") };
  const options = { agentId: "main", env };
  const scopes = ["parent", "child"].map((sessionId) => ({
    agentId: options.agentId,
    env,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
  }));
  for (const scope of scopes) {
    ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  }
  const database = agentDb.openOpenClawAgentDatabase(options);
  const databaseOptions = { ...options, path: database.path };
  const aliasPath = alias
    ? path.join(path.dirname(database.path), "writer-alias.sqlite")
    : undefined;
  if (aliasPath) {
    symlinkSync(database.path, aliasPath);
    agentDb.openOpenClawAgentDatabase({ ...options, path: aliasPath });
  }
  return {
    database,
    databaseOptions,
    scopes: scopes.map((scope) => Object.assign(scope, { storePath: aliasPath })),
    plan: {
      kind: "history-eviction",
      databaseOptions: resolveSessionReclamationDatabaseOptions(databaseOptions),
      diskBudget: {},
      materializedPlans: [],
      protectedSessionIds: [...new Set(scopes.map((scope) => scope.sessionId))],
      sessionId: "already-removed-history",
    } satisfies SqliteSessionReclamationPlan,
  };
}

function loggedFixture(name: string, silent = false) {
  const fixture = createFixture();
  const { databaseOptions } = fixture;
  agentDb.closeOpenClawAgentDatabasesForTest(databaseOptions.env.OPENCLAW_STATE_DIR);
  revokeSqliteDatabaseAdmissionsForPath(databaseOptions.path);
  const file = path.join(tempDirs.make(name), "reclamation.log");
  setLoggerOverride({ level: "info", consoleLevel: silent ? "silent" : undefined, file });
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const diagnostics: Diagnostics = {};
  const workers = observeReclamationWorkers();
  const advanceClock = (ms: number) => {
    clock += ms;
  };
  return { ...fixture, file, diagnostics, workers, advanceClock };
}

async function readLogRecords(file: string) {
  return (await fs.readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const record: unknown = JSON.parse(line);
      assert.ok(isRecord(record));
      return record;
    });
}

function append(scope: SessionAccessScope & { sessionId: string }, type = "session") {
  expect(
    appendTranscriptEventSync(scope, {
      type,
      ...(type === "session" ? { id: scope.sessionId } : {}),
    }),
  ).toEqual({ ok: true, value: true });
}

const write = <T>(
  options: Parameters<typeof runExclusiveSqliteSessionWrite>[0],
  run: () => Promise<T>,
) => runExclusiveSqliteSessionWrite(options, run, "session.transcript.batch");

async function expectWorkerRetirement(
  workers: ReturnType<typeof observeReclamationWorkers>,
  diagnostics: Diagnostics,
) {
  const matching = workers.filter((worker) => worker.threadId === diagnostics.workerThreadId);
  expect(matching).toHaveLength(1);
  const worker = matching[0]!;
  expect(worker.threadId).toBeGreaterThan(0);
  const id = worker.threadId;
  const exited = once(worker, "exit");
  await agentDb.closeOpenClawAgentDatabasesAsync();
  expect(worker.threadId).toBe(-1);
  expect(await exited).toEqual([0]);
  return id;
}

test.each([false, true])(
  "in-process reclamation checks authority before cold database admission (revoked: %s)",
  async (revoked) => {
    const { database, databaseOptions, scopes } = createFixture();
    const removed = scopes[0]!;
    const survivor = scopes[1]!;
    append(removed);
    const current = { ...removed, sessionId: "parent-current" };
    replaceSessionEntrySync(current, { sessionId: current.sessionId, updatedAt: 2 });
    append(current);
    const expectedEntry = loadSessionEntry(current);
    assert.ok(expectedEntry, "expected the native removal fixture entry");
    const plan = createLifecycleArtifactReclamationPlan({
      agentId: databaseOptions.agentId,
      databaseOptions,
      entries: [{ sessionKey: removed.sessionKey, expectedEntry }],
      materializedPlans: [],
    });
    const stateDatabase = stateDb.openOpenClawStateDatabase({ env: databaseOptions.env });
    const inspect = () => {
      const opened = withOpenClawAgentDatabaseReadOnly(({ db }) => {
        const all = (sql: string) => db.prepare(sql).all();
        return {
          entries: all("SELECT session_key, entry_json FROM session_nodes ORDER BY session_key"),
          windows: all(
            "SELECT session_id, session_key, previous_session_id FROM session_windows ORDER BY session_id",
          ),
          events: all(
            "SELECT session_id, seq, event_json FROM transcript_events ORDER BY session_id, seq",
          ),
          repairIndex: db
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?")
            .get("idx_agent_cache_expiry"),
        };
      }, databaseOptions);
      assert.ok(opened.found, "expected the existing native reclamation database");
      return {
        ...opened.value,
        writerOpen: agentDb.getOpenClawAgentDatabaseIfOpen(databaseOptions)?.db.isOpen ?? false,
        leases: stateDatabase.db
          .prepare("SELECT lease_id FROM agent_database_leases WHERE path = ? ORDER BY lease_id")
          .all(database.path),
      };
    };
    // The prepared operation loses its warm handle before it can enter the FIFO.
    database.db.exec("DROP INDEX idx_agent_cache_expiry");
    expect(agentDb.closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
    const before = inspect();
    expect(before).toMatchObject({ writerOpen: false, leases: [], repairIndex: undefined });
    const survivorEntry = loadSessionEntryReadOnly(survivor);
    const owner = acquireGatewayStateOwner({ databasePath: stateDatabase.path });
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: owner.assertCurrent,
      assertDatabaseAccess: owner.assertDatabaseAccess,
    });
    try {
      await maintenance.run(async () => {
        const operation = reclaim({
          plan,
          assertCommitAllowed: () => {
            if (revoked) {
              throw new Error("native reclamation authority revoked");
            }
          },
        });
        if (revoked) {
          await expect(operation).rejects.toThrow("native reclamation authority revoked");
          // Read-only observation must not reopen or repair the rejected target.
          expect(inspect()).toEqual(before);
          expect(loadSessionEntryReadOnly(current)).toEqual(expectedEntry);
        } else {
          await expect(operation).resolves.toMatchObject(removedArtifact);
          expect(inspect()).toMatchObject({
            writerOpen: true,
            repairIndex: { name: "idx_agent_cache_expiry" },
            events: before.events,
            windows: before.windows,
          });
          expect(loadSessionEntryReadOnly(current)).toBeUndefined();
        }
        expect(database.db.isOpen).toBe(false);
        expect(loadSessionEntryReadOnly(survivor)).toEqual(survivorEntry);
        await agentDb.closeOpenClawAgentDatabaseByPathAsync(database.path);
        expect(inspect()).toMatchObject({ writerOpen: false, leases: [] });
      });
    } finally {
      await maintenance.close();
      owner.release();
      await agentDb.closeOpenClawAgentDatabaseByPathAsync(database.path);
      await stateDb.closeOpenClawStateDatabaseAsync();
      stateDb.closeOpenClawStateDatabaseForTest();
    }
  },
);

test.runIf(process.platform !== "win32")(
  "keeps the opened database and its canonical writer queue after an alias retarget",
  async () => {
    const { databaseOptions, scopes } = createFixture(true);
    const removed = scopes[0]!;
    const aliasPath = removed.storePath;
    const expectedEntry = loadSessionEntry(removed);
    assert.ok(aliasPath && expectedEntry, "expected the aliased removal fixture entry");
    const replacementPath = path.join(path.dirname(databaseOptions.path), "replacement.sqlite");
    const replacementScope = { ...removed, storePath: replacementPath };
    replaceSessionEntrySync(replacementScope, expectedEntry);
    const plan = createLifecycleArtifactReclamationPlan({
      agentId: databaseOptions.agentId,
      databaseOptions: { ...databaseOptions, path: aliasPath },
      entries: [{ sessionKey: removed.sessionKey, expectedEntry }],
      materializedPlans: [],
    });
    let canonicalWrite: Promise<void> | undefined;
    let canonicalWriteRan = false;
    hooks.afterWriteAdmission = async () => {
      hooks.afterWriteAdmission = undefined;
      // The claim and Worker plan already belong to the original open database.
      await fs.unlink(aliasPath);
      symlinkSync(replacementPath, aliasPath);
      canonicalWrite = write(databaseOptions, async () => {
        canonicalWriteRan = true;
      });
      await yieldToEventLoop();
      expect(canonicalWriteRan).toBe(false);
    };
    const reclamation = reclaim({ plan });
    try {
      await expect(reclamation).resolves.toMatchObject(removedArtifact);
      expect(canonicalWrite).toBeDefined();
      await canonicalWrite;
      expect(canonicalWriteRan).toBe(true);
      const latest = (scope: SessionAccessScope) =>
        loadSessionEntry({ ...scope, readConsistency: "latest" });
      expect(latest({ ...removed, storePath: databaseOptions.path })).toBeUndefined();
      expect(latest(replacementScope)).toEqual(expectedEntry);
    } finally {
      await Promise.allSettled([reclamation, ...(canonicalWrite ? [canonicalWrite] : [])]);
    }
  },
);

test("one reclamation pass leaves a large freelist for bounded later maintenance", async () => {
  const { database, plan, scopes } = createFixture();
  // sqlite-allow-raw -- synthetic disposable pages exercise the real vacuum boundary.
  database.db.exec(`CREATE TABLE reclamation_fixture (payload BLOB);
    INSERT INTO reclamation_fixture VALUES (zeroblob(8388608));
    DROP TABLE reclamation_fixture;`);
  const freePages = () =>
    Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count);
  const before = freePages();
  expect(before).toBeGreaterThan(512);

  await expect(reclaim({ plan })).resolves.toMatchObject({
    value: { deleted: true },
  });

  const after = freePages();
  expect(before - after).toBeGreaterThan(0);
  expect(before - after).toBeLessThanOrEqual(512);
  expect(after).toBeGreaterThan(0);
  for (const scope of scopes) {
    append(scope);
  }
  const budgetBefore = freePages();
  const databaseOptions = plan.databaseOptions;
  await withSqliteSessionPageReclamation(databaseOptions, async (reclaimPages) => {
    const first = await reclaimPages();
    expect(first.remainingFreePages).toBeGreaterThan(0);
    expect(budgetBefore - first.remainingFreePages!).toBeGreaterThan(0);
    expect(budgetBefore - first.remainingFreePages!).toBeLessThanOrEqual(512);
    expect(database.db.isTransaction).toBe(false);
    for (const scope of scopes) {
      append(scope, "budget-progress");
    }
    await reclaimSqliteFreePages(databaseOptions, undefined, { reclaimPages });
  });
  const reopened = agentDb.openOpenClawAgentDatabase(databaseOptions);
  expect(Number(reopened.db.prepare("PRAGMA freelist_count").get()?.freelist_count)).toBe(0);
});

test("queued reclamations reuse their database Worker without borrowing another store's identity", async () => {
  const first = createFixture();
  const other = createFixture();
  const diagnostics: Diagnostics[] = [{}, {}, {}];
  const operations = [first, first, other].map(({ plan }, index) =>
    reclaim({ plan, diagnostics: diagnostics[index] }),
  );
  try {
    // The queued successor has not claimed a worker.
    expect(diagnostics[1]).not.toHaveProperty("workerThreadId");
    await Promise.all(operations);
    expect(diagnostics.map((record) => record.kind)).toEqual(Array(3).fill("history-eviction"));
    const ids = diagnostics.map((record) => record.workerThreadId);
    expect(ids.every((id) => typeof id === "number" && id > 0)).toBe(true);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  } finally {
    await Promise.allSettled(operations);
  }
});

test("file warnings retain rejected native admission releases without attributing them to a successor", async () => {
  const { databaseOptions, plan, file, diagnostics, workers, advanceClock } =
    loggedFixture("openclaw-writer-log-");
  let admissions = 0;
  let revoked = false;
  const failure = new Error("synthetic admission refusal");
  hooks.beforeWriteAdmission = async () => {
    if (admissions === 0) {
      // Revoke incoming warm proof at the actual cold prepare admission so native
      // validation releases and reacquires its own writer before acceptance.
      revokeSqliteDatabaseAdmissionsForPath(databaseOptions.path);
    }
    if (admissions === 1) {
      revoked = true;
    }
  };
  let second: Promise<string> | undefined;
  hooks.afterWriteAdmission = async () => {
    if (++admissions === 1) {
      second = write(databaseOptions, async () => "successor");
    }
    // Advance at actual admitted work, independently of timer-call counts.
    advanceClock(1_100);
  };
  const first = reclaim({
    plan,
    diagnostics,
    assertCommitAllowed: () => {
      if (revoked) {
        throw failure;
      }
    },
  });
  try {
    await expect(first).rejects.toBe(failure);
    expect(second).toBeDefined();
    await expect(second).resolves.toBe("successor");
    await flushLogger();
    const records = (await readLogRecords(file))
      .filter((record) => record["2"] === "slow SQLite session write")
      .map((record) => {
        const details = record["1"];
        assert.ok(isRecord(details));
        return details;
      });
    const workerThreadId = await expectWorkerRetirement(workers, diagnostics);
    expect(records).toHaveLength(3);
    const workerRecords = records.filter((record) => record.workerThreadId === workerThreadId);
    expect(workerRecords).toMatchObject(
      ["preliminary-release", "worker-release"].map((releaseCause, index) =>
        Object.assign({}, executionContext, {
          reclamationKind: "history-eviction",
          reclamationAdmissionId: index + 1,
          reclamationAdmissionReleaseCause: releaseCause,
        }),
      ),
    );
    const successor = records.find((record) => record.operation === "session.transcript.batch");
    expect(successor).toMatchObject(executionContext);
    for (const field of [
      "workerThreadId",
      "reclamationKind",
      "reclamationAdmissionId",
      "reclamationAdmissionReleaseCause",
    ]) {
      expect(successor).not.toHaveProperty(field);
    }
  } finally {
    await Promise.allSettled([first, second]);
  }
});

test.each([false, true])(
  "records the joined reclamation lifetime outside writers (rejected/log failure: %s)",
  async (rejected) => {
    const elapsedMs = 1_500;
    const { databaseOptions, plan, file, diagnostics, workers, advanceClock } = loggedFixture(
      "openclaw-reclamation-log-",
      true,
    );
    await fs.writeFile(file, "");
    const failure = new Error("synthetic reclamation refusal", {
      cause: new Error("synthetic storage failure; Authorization: Bearer synthetic-private-token"),
    });
    let revoked = false;
    let admissions = 0;
    let otherWriterRan = false;
    hooks.failWorkerLog = rejected;
    hooks.beforeWriteAdmission = async () => {
      if (++admissions === 1) {
        // Invalidate at native preparation's first admission, preserving the proof
        // owner while requiring validation to release its preliminary writer.
        revokeSqliteDatabaseAdmissionsForPath(databaseOptions.path);
        return;
      }
      if (admissions !== 2) {
        return;
      }
      // The first admission has ended; the second has not entered the writer FIFO.
      await write(databaseOptions, async () => {
        otherWriterRan = true;
      });
      advanceClock(elapsedMs);
      revoked = rejected;
    };
    const trace = { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: "01" };
    const operation = runWithDiagnosticTraceContext(trace, () =>
      reclaim({
        plan,
        diagnostics,
        assertCommitAllowed: () => {
          if (revoked) {
            throw failure;
          }
        },
      }),
    );
    try {
      if (rejected) {
        await expect(operation).rejects.toBe(failure);
      } else {
        await expect(operation).resolves.toMatchObject({ kind: "history-eviction" });
      }
      await flushLogger();
      const records = await readLogRecords(file);
      const observations = records.filter(
        (record) =>
          record.message === "slow SQLite reclamation Worker operation" ||
          record.message === "SQLite reclamation Worker failed",
      );
      expect(otherWriterRan).toBe(true);
      const workerThreadId = await expectWorkerRetirement(workers, diagnostics);
      expect(records.some((record) => record["2"] === "slow SQLite session write")).toBe(false);
      expect(hooks.workerLogAttempts).toBe(1);
      expect(observations).toHaveLength(rejected ? 0 : 1);
      if (!rejected) {
        expect(observations[0]).toMatchObject({
          ...trace,
          message: "slow SQLite reclamation Worker operation",
        });
        expect(observations[0]?.["1"]).toEqual({
          ...executionContext,
          reclamationKind: "history-eviction",
          workerThreadId,
          elapsedMs,
          outcome: "resolved",
        });
        expect(JSON.stringify(observations)).not.toContain("synthetic-private-token");
      }
      await expect(write(databaseOptions, async () => "after")).resolves.toBe("after");
    } finally {
      await Promise.allSettled([operation]);
    }
  },
);
