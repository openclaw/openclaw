import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { expect, test, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../../infra/sqlite-handle-lifecycle.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { flushLogger, setLoggerOverride } from "../../logging/logger.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import * as stateCache from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as sqliteArchive from "./session-accessor.sqlite-archive.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { loadSessionEntry } from "./session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import type {
  ReclamationDatabaseOptions,
  SqliteSessionReclamationPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import { observeSessionMaintenancePlanningWorker } from "./session-accessor.sqlite-maintenance.test-support.js";
import { observeReclamationWorkers } from "./session-accessor.sqlite-reclamation-reuse.test-support.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import { SqliteReclamationInputsChangedError } from "./session-accessor.sqlite-reclamation-worker-diagnostics.js";
import type { SqliteReclamationWorkerMessage } from "./session-accessor.sqlite-reclamation-worker.types.js";
import * as reclamation from "./session-accessor.sqlite-reclamation.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

async function withState(run: (state: OpenClawTestState) => Promise<void>, fileLog = false) {
  const options = {
    scenario: "minimal" as const,
    ...(fileLog ? { env: { OPENCLAW_TEST_FILE_LOG: "1" } } : {}),
  };
  await withOpenClawTestState(options, async (state) => {
    try {
      await run(state);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      if (fileLog) {
        await flushLogger();
        setLoggerOverride(null);
      }
    }
  });
}

function createEntryFixture(
  state: OpenClawTestState,
  sessionId: string,
  databaseOptions = databaseFor(state),
  env = state.env,
) {
  const scope = seed(state, sessionId, 1, env);
  const entry = loadSessionEntry(scope);
  assert.ok(entry);
  return {
    scope,
    entry,
    databaseOptions,
    plan: {
      kind: "entry",
      databaseOptions: reclamation.resolveSessionReclamationDatabaseOptions(databaseOptions),
      deleteParams: {
        archiveTranscript: false,
        storePath: databaseOptions.path,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      },
      preparedTargetSnapshot: [{ entry, sessionKey: scope.sessionKey }],
      materializedPlans: [],
    } satisfies SqliteSessionReclamationPlan,
  };
}

function databaseFor(state: OpenClawTestState, env = state.env) {
  const options = { agentId: "main", env: state.env };
  return { ...options, path: openOpenClawAgentDatabase(options).path, env };
}

function entries(
  state: OpenClawTestState,
  prefix: string,
  databaseOptions: ReclamationDatabaseOptions,
) {
  return Array.from({ length: 4 }, (_, index) =>
    createEntryFixture(state, `${prefix}-${index}`, databaseOptions),
  );
}

function seed(
  state: OpenClawTestState,
  sessionId: string,
  updatedAt = Date.now(),
  env = state.env,
) {
  const scope = {
    agentId: "main",
    env,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
  };
  ensureSessionEntrySync(scope, { sessionId, updatedAt });
  return scope;
}

function observeWorkers(onMessage?: (message: SqliteReclamationWorkerMessage) => void) {
  return observeReclamationWorkers((worker) => {
    if (onMessage) {
      worker.prependListener("message", onMessage);
    }
  });
}

const preservation = (providerKeys: string[] = []) => ({
  providerKeys,
  workIdentities: [],
  lifecycleIdentities: [],
});

function maintenanceFixture(state: OpenClawTestState) {
  const active = seed(state, "active");
  const victim = seed(state, "victim", 1);
  const databaseOptions = databaseFor(state);
  const input = {
    activeSessionKeys: [active.sessionKey],
    archiveDirectory: state.path("archives"),
    maintenance: { ...resolveMaintenanceConfigFromInput(), mode: "enforce" as const },
    preservation: preservation(),
    storePath: databaseOptions.path,
  };
  const request = {
    activeSessionKey: active.sessionKey,
    archiveDirectory: input.archiveDirectory,
    maintenanceConfig: input.maintenance,
    scope: databaseOptions,
    storePath: databaseOptions.path,
  };
  return { active, victim, databaseOptions, input, request };
}

async function logTo(state: OpenClawTestState, name: string, level: "info" | "debug" = "info") {
  const file = state.path(name);
  await fs.writeFile(file, "");
  setLoggerOverride({ level, consoleLevel: "silent", file });
  vi.spyOn(performance, "now").mockReturnValue(0);
  return file;
}

async function readLogs(file: string): Promise<{ content: string; records: unknown[] }> {
  await flushLogger();
  const content = await fs.readFile(file, "utf8");
  return {
    content,
    records: content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

test("retains one archive Worker across refused and interleaved reclamation operations", () =>
  withState(async (state) => {
    const options = { agentId: "main", env: state.env };
    const databaseOptions = reclamation.resolveSessionReclamationDatabaseOptions(options);
    const base = { databaseOptions, materializedPlans: [] };
    const fixtures = entries(state, "interleaved", databaseOptions);
    let refusalPoint: "admission-request" | undefined;
    let superseded = false;
    const workers = observeWorkers((message) => {
      if (message.type === refusalPoint) {
        superseded = true;
      }
    });
    for (const { scope, plan } of fixtures) {
      const plans: SqliteSessionReclamationPlan[] = [
        plan,
        {
          ...base,
          kind: "history-eviction",
          diskBudget: {},
          protectedSessionIds: [],
          sessionId: scope.sessionId,
        },
        reclamation.createSessionMaintenanceStatisticsOperation(databaseOptions),
        {
          ...base,
          kind: "archive-publish-prepare",
          archiveDirectory: state.path("archives"),
          requested: [],
        },
        { ...base, kind: "archive-publish-record", results: [], nowMs: 1 },
      ];
      for (const operation of plans) {
        if (operation.kind !== "maintenance-statistics") {
          refusalPoint = "admission-request";
          await expect(
            runSqliteSessionReclamation({
              plan: operation,
              assertCommitAllowed: () => {
                if (superseded) {
                  throw new SqliteReclamationInputsChangedError("synthetic inputs changed");
                }
              },
            }),
          ).rejects.toThrow(SqliteReclamationInputsChangedError);
          refusalPoint = undefined;
          superseded = false;
        }
        await expect(runSqliteSessionReclamation({ plan: operation })).resolves.toMatchObject({
          kind: operation.kind,
        });
        expect(workers).toHaveLength(1);
      }
      expect(loadSessionEntry(scope)).toBeUndefined();
    }
    expect(workers).toHaveLength(1);
  }));

test("retires a retained Worker by the symlinked root its requester used", () =>
  withState(async (state) => {
    const link = path.join(state.root, "state-link");
    const stateDir = expectDefined(state.env.OPENCLAW_STATE_DIR, "test state directory");
    await fs.symlink(stateDir, link, process.platform === "win32" ? "junction" : "dir");
    // The Worker runs at the physical path; cleanup selects the lexical path the caller used.
    const options = { agentId: "main", env: { ...state.env, OPENCLAW_STATE_DIR: link } };
    const databaseOptions = reclamation.resolveSessionReclamationDatabaseOptions(options);
    const { plan } = createEntryFixture(state, "linked", databaseOptions, options.env);
    const spawned = observeWorkers();
    await runSqliteSessionReclamation({ plan });
    expect(spawned).toHaveLength(1);
    await closeOpenClawAgentDatabasesAsync(link);
    expect(spawned[0]?.threadId).toBe(-1);
  }));

test("binds first shared-state creation without host SQL and reuses reclamation until thirty idle minutes", () =>
  withState(async (state) => {
    const databaseOptions = databaseFor(state, {
      ...state.env,
      OPENCLAW_STATE_DIR: state.statePath("reclamation-owner"),
    });
    const sharedAdmission = stateCache.captureOpenClawStateDatabaseReadAdmission(
      resolveOpenClawStateSqlitePath(databaseOptions.env),
    );
    expect(sharedAdmission.identity.key).toMatch(/^path:/);
    const publishAdmission = stateCache.publishOpenClawStateDatabaseWorkerAdmission;
    vi.spyOn(stateCache, "publishOpenClawStateDatabaseWorkerAdmission").mockImplementation(
      (admission) => {
        const sql = observeHostDataSql();
        try {
          publishAdmission(admission);
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
        }
      },
    );
    const fixtures = entries(state, "synthetic-reclamation-idle", databaseOptions);
    const workers = observeWorkers();
    const reclaim = async (index: number) => {
      const diagnostics: SqliteSessionReclamationDiagnostics = {};
      const fixture = fixtures[index];
      assert.ok(fixture);
      await runSqliteSessionReclamation({ plan: fixture.plan, diagnostics });
      expect(loadSessionEntry(fixture.scope)).toBeUndefined();
      return diagnostics.workerThreadId;
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const firstThread = await reclaim(0);
    expect(sharedAdmission.identity.key).toMatch(/^file:/);
    sharedAdmission.assertCurrent();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await reclaim(1)).toBe(firstThread);
    await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    expect(await reclaim(2)).toBe(firstThread);
    expect(workers).toHaveLength(1);
    const worker = workers[0];
    assert.ok(worker);
    const exited = once(worker, "exit");
    await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS);
    await exited;
    expect(await reclaim(3)).not.toBe(firstThread);
    expect(workers).toHaveLength(2);
  }));

test.each(["established", "first-created"] as const)(
  "retains a late lease receipt for exact cleanup after source read admission is revoked (%s)",
  (sharedState) =>
    withState(async (state) => {
      const env =
        sharedState === "first-created"
          ? { ...state.env, OPENCLAW_STATE_DIR: state.statePath("late-lease-owner") }
          : state.env;
      const { scope, databaseOptions, entry, plan } = createEntryFixture(
        state,
        "synthetic-late-lease",
        databaseFor(state, env),
      );
      const sharedPath = resolveOpenClawStateSqlitePath(databaseOptions.env);
      const admission = stateCache.captureOpenClawStateDatabaseReadAdmission(sharedPath);
      expect(admission.identity.key.startsWith("path:")).toBe(sharedState === "first-created");
      let revoked = false;
      const workers = observeWorkers((message) => {
        if (message.type === "lease") {
          // Native acquisition already committed, but its notification has not reached the owner.
          expect(message.receipt).toMatchObject({
            sharedStateIdentity: readDatabasePathIdentitySync(sharedPath).key,
            sharedStatePath: sharedPath,
            agentId: databaseOptions.agentId,
            path: databaseOptions.path,
            ownerPid: process.pid,
          });
          expect(admission.identity.key.startsWith("path:")).toBe(sharedState === "first-created");
          stateCache.clearOpenClawStateDatabaseOpenFailure(sharedPath);
          revoked = true;
          expect(() => admission.assertCurrent()).toThrow("read admission changed");
        }
      });
      await expect(runSqliteSessionReclamation({ plan })).rejects.toThrow(
        "OpenClaw state database read admission changed",
      );
      expect(revoked).toBe(true);
      expect(admission.assertCurrent).toThrow("read admission changed");
      expect(admission.identity.key).toBe(readDatabasePathIdentitySync(sharedPath).key);
      expect(workers.at(-1)?.threadId).toBe(-1);
      expect(loadSessionEntry(scope)).toEqual(entry);
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      expect(
        openOpenClawStateDatabase({ env: databaseOptions.env })
          .db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?")
          .all(databaseOptions.path),
      ).toEqual([]);
    }),
);

test("logs a native reclamation Worker throw with its cause, first frame and hashed session", () =>
  withState(async (state) => {
    const { scope, entry, plan } = createEntryFixture(state, "synthetic-reclamation-session");
    const file = await logTo(state, "reclamation.log");
    const secret = "synthetic-worker-credential";
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
     parentPort.once("message", function failReclamation() {
       parentPort.postMessage({ type: "closed", settled: true, cleanupWarnings: [] });
       throw new Error("synthetic reclamation crash for " + workerData.sessionId, {
         cause: new Error("synthetic disk failure; Authorization: Bearer " + workerData.secret),
       });
     });`,
      { eval: true, execArgv: [], workerData: { sessionId: scope.sessionId, secret } },
    );
    const workerThreadId = worker.threadId;
    vi.spyOn(sqliteArchive, "createSqliteTranscriptArchiveWorker").mockReturnValueOnce(worker);
    try {
      await expect(runSqliteSessionReclamation({ plan })).rejects.toThrow(
        "synthetic reclamation crash",
      );
      expect(worker.threadId).toBe(-1);
      expect(loadSessionEntry(scope)).toEqual(entry);
      const { content, records } = await readLogs(file);
      expect(records).toMatchObject([
        {
          message: "SQLite reclamation Worker failed",
          "1": {
            reclamationKind: "entry",
            sessionIdHash: redactIdentifier(scope.sessionId),
            workerThreadId,
            exitCode: 1,
            outcome: "rejected",
            error: expect.stringContaining(
              `synthetic reclamation crash for ${redactIdentifier(scope.sessionId)} | synthetic disk failure`,
            ),
            errorFrame: expect.stringMatching(/^at (?:MessagePort\.)?failReclamation \(/u),
          },
        },
        {
          message: "reclamation worker retired reason=failure kind=entry ageMs=0 opsServed=1",
          "1": { reason: "failure", kind: "entry", ageMs: 0, opsServed: 1, workerThreadId },
        },
      ]);
      expect(content).not.toContain(secret);
      expect(content).not.toContain(scope.sessionId);
    } finally {
      await worker.terminate();
    }
  }, true));

test.each(["active key", "provider"] as const)(
  "commits maintenance despite unrelated %s changes during Worker planning",
  (change) =>
    withState(async (state) => {
      const { active: scope, victim, request } = maintenanceFixture(state);
      const { sessionKey } = scope;
      const unrelated = seed(state, "unrelated");
      const file = await logTo(state, "maintenance-race.log", "debug");
      const plans = new Set<SqliteSessionReclamationPlan>();
      const firstRun = createDeferredCore<unknown>();
      let armed = false;
      const run = reclamationRun.runSqliteSessionReclamation;
      vi.spyOn(reclamationRun, "runSqliteSessionReclamation").mockImplementation((params) => {
        if (params.plan.kind === "maintenance-plan") {
          plans.add(params.plan);
        }
        armed = params.plan.kind === "maintenance-plan" && params.plan.input.preservation !== null;
        const operation = run(params);
        if (armed) {
          firstRun.resolve(operation);
        }
        return operation;
      });
      const workerThreadIds: number[] = [];
      let raced = false;
      const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
        capture: () => (change === "provider" && raced ? [unrelated.sessionKey] : []),
        dispose() {},
      }));
      observeSessionMaintenancePlanningWorker({
        afterPrepare() {
          if (raced || !armed) {
            return;
          }
          // Change live protection after native selection, before writer admission.
          raced = true;
          runOpenClawAgentWriteTransaction((owner) => {
            writeSessionEntry(owner, unrelated.sessionKey, {
              sessionId: unrelated.sessionId,
              updatedAt: Date.now(),
              label: "concurrent-write",
            });
          }, scope);
          kickSessionEntryMaintenanceAfterWrite({
            ...request,
            activeSessionKey: change === "active key" ? unrelated.sessionKey : sessionKey,
          });
        },
        afterExecute(result) {
          if (armed) {
            workerThreadIds.push(result.workerThreadId);
          }
        },
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        kickSessionEntryMaintenanceAfterWrite(request);
        await expect(firstRun.promise).resolves.toMatchObject({
          kind: "maintenance-plan",
          value: { archived: 1 },
        });
        expect(loadSessionEntry(victim)?.archiveReason).toBe("age-retention");
        expect(raced).toBe(true);
        expect(loadSessionEntry(unrelated)?.label).toBe("concurrent-write");
        expect(workerThreadIds).toHaveLength(1);
        expect(workerThreadIds[0]).toBeGreaterThan(0);
        const { records } = await readLogs(file);
        for (const message of [
          "SQLite reclamation Worker superseded by newer inputs",
          "SQLite reclamation Worker failed",
          "SQLite automatic session maintenance failed",
        ]) {
          expect(records).not.toContainEqual(expect.objectContaining({ message }));
        }
        expect(plans.size).toBe(1);
      } finally {
        unregister();
        vi.useRealTimers();
        vi.restoreAllMocks();
        await closeOpenClawAgentDatabasesAsync(state.stateDir);
      }
    }, true),
);

test("retains a selected maintenance row protected after native preparation", () =>
  withState(async (state) => {
    const { active, victim, databaseOptions, input } = maintenanceFixture(state);
    const originalVictim = structuredClone(loadSessionEntry(victim));
    expect(originalVictim).toMatchObject({ sessionId: victim.sessionId, updatedAt: 1 });
    let protection = input.preservation;
    const plan = {
      kind: "maintenance-plan",
      databaseOptions: reclamation.resolveSessionReclamationDatabaseOptions(databaseOptions),
      materializedPlans: [],
      input,
    } satisfies SqliteSessionReclamationPlan;
    const refreshed = vi.fn(() => ({
      activeSessionKeys: [active.sessionKey],
      preservation: protection,
    }));
    observeSessionMaintenancePlanningWorker({
      afterPrepare() {
        protection = preservation([victim.sessionKey]);
      },
    });
    await expect(
      runSqliteSessionReclamation({
        plan,
        refreshMaintenanceProtection: refreshed,
      }),
    ).resolves.toEqual({ kind: "maintenance-plan-stale" });
    expect(refreshed).toHaveReturnedWith({
      activeSessionKeys: [active.sessionKey],
      preservation: preservation([victim.sessionKey]),
    });
    expect(loadSessionEntry(victim)).toEqual(originalVictim);
  }));
