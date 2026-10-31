import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { expect, test, vi } from "vitest";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { sampleTrackedWorkerMemory } from "../../infra/worker-cpu.js";
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
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { loadSessionEntry } from "./session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import type { SqliteSessionReclamationPlan } from "./session-accessor.sqlite-lifecycle-types.js";
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

test("refuses changed reclamation inputs at admission without deleting the entry", () =>
  withState(async (state) => {
    const { scope, entry, plan } = createEntryFixture(state, "changed-inputs");
    let changed = false;
    observeWorkers((message) => {
      changed ||= message.type === "admission-request";
    });
    await expect(
      runSqliteSessionReclamation({
        plan,
        assertCommitAllowed() {
          if (changed) {
            throw new SqliteReclamationInputsChangedError("synthetic inputs changed");
          }
        },
      }),
    ).rejects.toThrow(SqliteReclamationInputsChangedError);
    expect(changed).toBe(true);
    expect(loadSessionEntry(scope)).toEqual(entry);
  }));

test("samples retained Worker buffers and retires it by the requester's symlinked root", () =>
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
    const threadId = spawned[0]!.threadId;
    const sample = sampleTrackedWorkerMemory({ refresh: false }).workerHeaps.find(
      (worker) => worker.threadId === threadId,
    );
    expect(sample?.external).toBeGreaterThan(0);
    expect(sample?.arrayBuffers).toBeGreaterThan(0);
    await closeOpenClawAgentDatabasesAsync(link);
    expect(spawned[0]?.threadId).toBe(-1);
    expect(
      sampleTrackedWorkerMemory({ refresh: false }).workerHeaps.some(
        (worker) => worker.threadId === threadId,
      ),
    ).toBe(false);
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
      // Exercise lease publication during preparation, before deletion is admitted.
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
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
      const firstRun = createDeferredCore<unknown>();
      let armed = false;
      const run = reclamationRun.runSqliteSessionReclamation;
      vi.spyOn(reclamationRun, "runSqliteSessionReclamation").mockImplementation((params) => {
        armed = params.plan.kind === "maintenance-plan" && params.plan.input.preservation !== null;
        const operation = run(params);
        if (armed) {
          firstRun.resolve(operation);
        }
        return operation;
      });
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
      } finally {
        unregister();
        vi.useRealTimers();
        vi.restoreAllMocks();
        await closeOpenClawAgentDatabasesAsync(state.stateDir);
      }
    }),
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
    const refreshed = () => ({
      activeSessionKeys: [active.sessionKey],
      preservation: protection,
    });
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
    expect(loadSessionEntry(victim)).toEqual(originalVictim);
  }));
