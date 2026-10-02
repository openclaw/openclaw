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
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import * as stateCache from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as sqliteArchive from "./session-accessor.sqlite-archive.js";
import type {
  SessionAccessScope,
  SqliteSessionReclamationDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { loadSessionEntry } from "./session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import type {
  ReclamationDatabaseOptions,
  SqliteSessionReclamationPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import { SqliteReclamationInputsChangedError } from "./session-accessor.sqlite-reclamation-worker-diagnostics.js";
import type { SqliteReclamationWorkerMessage } from "./session-accessor.sqlite-reclamation-worker.types.js";
import * as reclamation from "./session-accessor.sqlite-reclamation.js";
import { createSessionEntryReclamationPlan } from "./session-accessor.sqlite-reclamation.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

function createEntryFixture(
  scope: SessionAccessScope & { sessionId: string },
  databaseOptions: ReclamationDatabaseOptions,
) {
  ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const entry = loadSessionEntry(scope);
  assert.ok(entry);
  return {
    scope,
    entry,
    plan: createSessionEntryReclamationPlan({
      databaseOptions,
      deleteParams: {
        archiveTranscript: false,
        storePath: databaseOptions.path,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      },
      preparedTargetSnapshot: [{ entry, sessionKey: scope.sessionKey }],
      materializedPlans: [],
    }),
  };
}

test("retains one Worker across twenty admission refusals and interleaved reclamation operations", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const databaseOptions = reclamation.resolveSessionReclamationDatabaseOptions(options);
    const entries = Array.from({ length: 4 }, (_, index) =>
      createEntryFixture(
        {
          ...options,
          sessionId: `interleaved-${index}`,
          sessionKey: `agent:main:interleaved-${index}`,
        },
        databaseOptions,
      ),
    );
    let refusalPoint: "admission-request" | "commit-request" | undefined;
    let superseded = false;
    const create = sqliteArchive.createSqliteTranscriptArchiveWorker;
    const spawn = vi
      .spyOn(sqliteArchive, "createSqliteTranscriptArchiveWorker")
      .mockImplementation((data) => {
        const worker = create(data);
        worker.prependListener("message", (message: { type: string }) => {
          if (message.type === refusalPoint) {
            superseded = true;
          }
        });
        return worker;
      });
    try {
      for (const { scope, plan } of entries) {
        const plans: SqliteSessionReclamationPlan[] = [
          plan,
          reclamation.createHistoryEvictionReclamationPlan({
            databaseOptions,
            diskBudget: {},
            materializedPlans: [],
            protectedSessionIds: new Set(),
            sessionId: scope.sessionId,
          }),
          reclamation.createSessionMaintenanceStatisticsOperation(databaseOptions),
          {
            kind: "archive-publish-prepare",
            databaseOptions,
            materializedPlans: [],
            archiveDirectory: state.path("archives"),
            requested: [],
          },
          {
            kind: "archive-publish-record",
            databaseOptions,
            materializedPlans: [],
            results: [],
            nowMs: 1,
          },
        ];
        for (const operation of plans) {
          const refusals =
            operation.kind === "maintenance-statistics"
              ? (["admission-request", "commit-request"] as const)
              : (["admission-request"] as const);
          for (const point of refusals) {
            refusalPoint = point;
            await expect(
              runSqliteSessionReclamation({
                forceInProcess: false,
                plan: operation,
                assertCommitAllowed: () => {
                  if (superseded) {
                    throw new SqliteReclamationInputsChangedError(
                      "synthetic inputs changed before commit",
                    );
                  }
                },
              }),
            ).rejects.toThrow(SqliteReclamationInputsChangedError);
            refusalPoint = undefined;
            superseded = false;
          }
          await expect(
            runSqliteSessionReclamation({ forceInProcess: false, plan: operation }),
          ).resolves.toMatchObject({ kind: operation.kind });
          expect(spawn).toHaveBeenCalledTimes(1);
        }
        expect(loadSessionEntry(scope)).toBeUndefined();
      }
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

test.each(["path", "root"] as const)(
  "retires a retained Worker by the symlinked %s its requester used",
  async (retirement) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const link = path.join(state.root, "state-link");
      const stateDir = expectDefined(state.env.OPENCLAW_STATE_DIR, "test state directory");
      await fs.symlink(stateDir, link, process.platform === "win32" ? "junction" : "dir");
      // The Worker runs at the physical path; cleanup selects the lexical path the caller used.
      const options = { agentId: "main", env: { ...state.env, OPENCLAW_STATE_DIR: link } };
      const databaseOptions = reclamation.resolveSessionReclamationDatabaseOptions(options);
      const scope = { ...options, sessionId: "linked", sessionKey: "agent:main:linked" };
      const { plan } = createEntryFixture(scope, databaseOptions);
      const spawned: Worker[] = [];
      const create = sqliteArchive.createSqliteTranscriptArchiveWorker;
      vi.spyOn(sqliteArchive, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
        const worker = create(data);
        spawned.push(worker);
        return worker;
      });
      try {
        await runSqliteSessionReclamation({
          forceInProcess: false,
          plan,
        });
        expect(spawned).toHaveLength(1);
        await (retirement === "path"
          ? closeOpenClawAgentDatabaseByPathAsync(databaseOptions.path)
          : closeOpenClawAgentDatabasesAsync(link));
        expect(spawned[0]?.threadId).toBe(-1);
      } finally {
        vi.restoreAllMocks();
      }
    });
  },
);

test("binds first shared-state creation without host SQL and reuses reclamation until thirty idle minutes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const databaseOptions = {
      ...options,
      path: openOpenClawAgentDatabase(options).path,
      env: { ...state.env, OPENCLAW_STATE_DIR: state.statePath("reclamation-owner") },
    };
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
    const entries = Array.from({ length: 4 }, (_, index) =>
      createEntryFixture(
        {
          ...options,
          sessionId: `synthetic-reclamation-idle-${index}`,
          sessionKey: `agent:main:synthetic-reclamation-idle-${index}`,
        },
        databaseOptions,
      ),
    );
    const workers: Worker[] = [];
    const spawn = sqliteArchive.createSqliteTranscriptArchiveWorker;
    vi.spyOn(sqliteArchive, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
      const worker = spawn(data);
      workers.push(worker);
      return worker;
    });
    const reclaim = async (index: number) => {
      const diagnostics: SqliteSessionReclamationDiagnostics = {};
      const fixture = entries[index];
      assert.ok(fixture);
      await runSqliteSessionReclamation({
        forceInProcess: false,
        plan: fixture.plan,
        diagnostics,
      });
      expect(loadSessionEntry(fixture.scope)).toBeUndefined();
      return diagnostics.workerThreadId;
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
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
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});

test.each(["established", "first-created"] as const)(
  "retains a late lease receipt for exact cleanup after source read admission is revoked (%s)",
  async (sharedState) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionId: "synthetic-late-lease",
        sessionKey: "agent:main:synthetic-late-lease",
      };
      const databaseOptions = {
        agentId: scope.agentId,
        env:
          sharedState === "first-created"
            ? { ...state.env, OPENCLAW_STATE_DIR: state.statePath("late-lease-owner") }
            : state.env,
        path: openOpenClawAgentDatabase(scope).path,
      };
      const { entry, plan } = createEntryFixture(scope, databaseOptions);
      const sharedPath = resolveOpenClawStateSqlitePath(databaseOptions.env);
      const admission = stateCache.captureOpenClawStateDatabaseReadAdmission(sharedPath);
      expect(admission.identity.key.startsWith("path:")).toBe(sharedState === "first-created");
      const spawn = sqliteArchive.createSqliteTranscriptArchiveWorker;
      let child: Worker | undefined;
      let revoked = false;
      vi.spyOn(sqliteArchive, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
        const worker = spawn(data);
        child = worker;
        worker.prependListener("message", (message: SqliteReclamationWorkerMessage) => {
          if (message.type === "lease") {
            // Native acquisition already committed, but its notification has not reached the owner.
            const physical = readDatabasePathIdentitySync(sharedPath);
            const receipt = message.receipt;
            expect(receipt.sharedStateIdentity).toBe(physical.key);
            expect(receipt.sharedStatePath).toBe(sharedPath);
            expect(receipt.agentId).toBe(databaseOptions.agentId);
            expect(receipt.path).toBe(databaseOptions.path);
            expect(receipt.ownerPid).toBe(process.pid);
            expect(admission.identity.key.startsWith("path:")).toBe(
              sharedState === "first-created",
            );
            stateCache.clearOpenClawStateDatabaseOpenFailure(sharedPath);
            revoked = true;
            expect(() => admission.assertCurrent()).toThrow("read admission changed");
          }
        });
        return worker;
      });
      try {
        await expect(
          runSqliteSessionReclamation({
            forceInProcess: false,
            plan,
          }),
        ).rejects.toThrow("OpenClaw state database read admission changed");
        expect(revoked).toBe(true);
        expect(admission.assertCurrent).toThrow("read admission changed");
        expect(admission.identity.key).toBe(readDatabasePathIdentitySync(sharedPath).key);
        expect(child?.threadId).toBe(-1);
        expect(loadSessionEntry(scope)).toEqual(entry);
        await closeOpenClawAgentDatabasesAsync(state.stateDir);
        expect(
          openOpenClawStateDatabase({ env: databaseOptions.env })
            .db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?")
            .all(databaseOptions.path),
        ).toEqual([]);
      } finally {
        vi.restoreAllMocks();
      }
    });
  },
);

test("logs a native reclamation Worker throw with its cause, first frame and hashed session", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_FILE_LOG: "1" } },
    async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionId: "synthetic-reclamation-session",
        sessionKey: "agent:main:synthetic-reclamation-session",
      };
      const databaseOptions = {
        agentId: scope.agentId,
        env: state.env,
        path: openOpenClawAgentDatabase(scope).path,
      };
      const { entry, plan } = createEntryFixture(scope, databaseOptions);
      const file = state.path("reclamation.log");
      await fs.writeFile(file, "");
      setLoggerOverride({ level: "info", consoleLevel: "silent", file });
      vi.spyOn(performance, "now").mockReturnValue(0);
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
        await expect(
          runSqliteSessionReclamation({
            forceInProcess: false,
            plan,
          }),
        ).rejects.toThrow("synthetic reclamation crash");
        expect(worker.threadId).toBe(-1);
        expect(loadSessionEntry(scope)).toEqual(entry);
        await flushLogger();
        const content = await fs.readFile(file, "utf8");
        const records: unknown[] = content
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        expect(records).toEqual([
          expect.objectContaining({
            message: "SQLite reclamation Worker failed",
            "1": expect.objectContaining({
              reclamationKind: "entry",
              sessionIdHash: redactIdentifier(scope.sessionId),
              workerThreadId,
              exitCode: 1,
              outcome: "rejected",
              error: expect.stringContaining(
                `synthetic reclamation crash for ${redactIdentifier(scope.sessionId)} | synthetic disk failure`,
              ),
              errorFrame: expect.stringMatching(/^at (?:MessagePort\.)?failReclamation \(/u),
            }),
          }),
          expect.objectContaining({
            message: "reclamation worker retired reason=failure kind=entry ageMs=0 opsServed=1",
            "1": expect.objectContaining({
              reason: "failure",
              kind: "entry",
              ageMs: 0,
              opsServed: 1,
              workerThreadId,
            }),
          }),
        ]);
        expect(content).not.toContain(secret);
        expect(content).not.toContain(scope.sessionId);
      } finally {
        await worker.terminate();
        vi.restoreAllMocks();
        await flushLogger();
        setLoggerOverride(null);
      }
    },
  );
});

test.each(["active key", "provider"] as const)(
  "commits maintenance despite unrelated %s changes during Worker planning",
  async (change) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_FILE_LOG: "1" } },
      async (state) => {
        const sessionKey = "agent:main:synthetic-maintenance-race";
        const scope = {
          agentId: "main",
          env: state.env,
          sessionKey,
          sessionId: "maintenance-race",
        };
        ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
        const victim = {
          ...scope,
          sessionKey: "agent:main:maintenance-victim",
          sessionId: "victim",
        };
        ensureSessionEntrySync(victim, { sessionId: victim.sessionId, updatedAt: 1 });
        const unrelated = {
          ...scope,
          sessionKey: "agent:main:maintenance-unrelated",
          sessionId: "unrelated",
        };
        ensureSessionEntrySync(unrelated, {
          sessionId: unrelated.sessionId,
          updatedAt: Date.now(),
        });
        const database = openOpenClawAgentDatabase(scope);
        const request = {
          activeSessionKey: sessionKey,
          archiveDirectory: state.path("archives"),
          maintenanceConfig: { ...resolveMaintenanceConfigFromInput(), mode: "enforce" as const },
          scope: { agentId: scope.agentId, env: state.env, path: database.path },
          storePath: database.path,
        };
        const file = state.path("maintenance-race.log");
        await fs.writeFile(file, "");
        setLoggerOverride({ level: "debug", consoleLevel: "silent", file });
        vi.spyOn(performance, "now").mockReturnValue(0);
        const plans = vi.spyOn(reclamation, "createSessionMaintenancePlanningOperation");
        const runs: Promise<unknown>[] = [];
        const firstRun = createDeferredCore();
        let armed = false;
        const run = reclamationRun.runSqliteSessionReclamation;
        vi.spyOn(reclamationRun, "runSqliteSessionReclamation").mockImplementation((params) => {
          armed =
            params.plan.kind === "maintenance-plan" && params.plan.input.preservation !== null;
          const operation = run(params);
          if (armed) {
            runs.push(operation);
            firstRun.resolve();
          }
          return operation;
        });
        const spawn = sqliteArchive.createSqliteTranscriptArchiveWorker;
        let raced = false;
        const unregister = registerSessionMaintenancePreserveKeysProvider(() =>
          change === "provider" && raced ? [unrelated.sessionKey] : [],
        );
        const constructions = vi
          .spyOn(sqliteArchive, "createSqliteTranscriptArchiveWorker")
          .mockImplementation((data) => {
            const worker = spawn(data);
            worker.prependListener("message", (message: { type: string }) => {
              if (message.type !== "admission-request" || raced || !armed) {
                return;
              }
              // A different active row is outside the plan's destructive candidates.
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
            });
            return worker;
          });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          kickSessionEntryMaintenanceAfterWrite(request);
          await firstRun.promise;
          await expect(runs[0]).resolves.toMatchObject({
            kind: "maintenance-plan",
            value: { archived: 1 },
          });
          expect(loadSessionEntry(victim)?.archiveReason).toBe("age-retention");
          expect(raced).toBe(true);
          expect(loadSessionEntry(unrelated)?.label).toBe("concurrent-write");
          expect(constructions).toHaveBeenCalledTimes(1);
          await flushLogger();
          const records: unknown[] = (await fs.readFile(file, "utf8"))
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          const logged = (message: string) => expect.objectContaining({ message });
          expect(records).not.toContainEqual(
            logged("SQLite reclamation Worker superseded by newer inputs"),
          );
          expect(records).not.toContainEqual(logged("SQLite reclamation Worker failed"));
          expect(records).not.toContainEqual(logged("SQLite automatic session maintenance failed"));

          expect(plans).toHaveBeenCalledTimes(1);
        } finally {
          unregister();
          vi.useRealTimers();
          vi.restoreAllMocks();
          await closeOpenClawAgentDatabasesAsync(state.stateDir);
          await flushLogger();
          setLoggerOverride(null);
        }
      },
    );
  },
);
