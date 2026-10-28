import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { sessionNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import { createLifecycleArtifactReclamationPlan } from "./session-accessor.sqlite-reclamation.js";

const nativePreload = vi.hoisted(() => ({
  moduleUrl: "",
  path: "",
  gate: undefined as SharedArrayBuffer | undefined,
  worker: undefined as Worker | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        const selected = nativePreload.path && filename.toString() === nativePreload.moduleUrl;
        let workerOptions = options;
        if (selected) {
          workerOptions = {
            ...options,
            execArgv: [
              ...(options?.execArgv ?? []),
              "--import",
              pathToFileURL(nativePreload.path).href,
            ],
            workerData: { ...options?.workerData, fixtureNativeGate: nativePreload.gate },
          };
        }
        super(filename, workerOptions);
        if (selected) {
          nativePreload.worker = this;
        }
      }
    },
  };
});
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    Object.assign(nativePreload, { path: "", moduleUrl: "", worker: undefined, gate: undefined });
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it.each([
  { phase: "before-request", cleanup: "rollback" },
  { phase: "before-request", cleanup: "close" },
  { phase: "before-request", cleanup: "unsettled" },
  { phase: "after-commit", cleanup: "rollback" },
  { phase: "after-commit", cleanup: "close" },
  { phase: "after-commit", cleanup: "unsettled" },
] as const)("$phase maintenance with $cleanup cleanup", async ({ phase, cleanup }) => {
  const unsafe = cleanup === "unsettled";
  const root = dirs.make("reclamation-maintenance-");
  const env = { OPENCLAW_STATE_DIR: root };
  const options = { agentId: "main", env };
  ensureSessionEntrySync(
    { ...options, sessionKey: "agent:main:fixture" },
    { sessionId: "fixture", updatedAt: 1 },
  );
  const state = openOpenClawStateDatabase({ env });
  const source = openOpenClawAgentDatabase(options);
  const databaseOptions = { ...options, path: source.path };
  const reclaim = () =>
    runSqliteSessionReclamation({
      plan: createLifecycleArtifactReclamationPlan({
        agentId: options.agentId,
        databaseOptions,
        entries: [],
        materializedPlans: [],
      }),
      assertCommitAllowed() {},
    });
  const arm = path.join(root, "armed");
  const capturedMaintenance = path.join(root, "captured-maintenance");
  const receipt = path.join(root, "native-events.json");
  const preload = path.join(root, "deferred-maintenance.mjs");
  writeFileSync(
    preload,
    `
      import fs from 'node:fs';
      import { DatabaseSync } from 'node:sqlite';
      import { parentPort, workerData } from 'node:worker_threads';
      const { register } = await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))});
      register();
      const { observeSqliteWalPeriodicWork } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(sessionNativeProcessEntrypoints.walScheduler).href)});
      const target = ${JSON.stringify(realpathSync(source.path))};
      const phase = ${JSON.stringify(phase)};
      const unsafe = ${JSON.stringify(unsafe)};
      const failRollback = ${JSON.stringify(cleanup !== "rollback")};
      const events = [];
      let lastDatabase, triggered = false, vacuumDatabase, failed;
      const selected = (db) => {
        const location = db.location();
        return location && fs.realpathSync(location) === target;
      };
      const scheduled = observeSqliteWalPeriodicWork(() => {
        if (!lastDatabase || !selected(lastDatabase)) return false;
        fs.writeFileSync(${JSON.stringify(capturedMaintenance)}, 'captured');
        return true;
      });
      const record = (step, db) => {
        events.push({ step, isOpen: db.isOpen, isTransaction: db.isTransaction });
        fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(events));
      };
      const tick = () => {
        if (triggered) return;
        const admissions = globalThis[Symbol.for('openclaw.sqliteWalWriteAdmissions')];
        const admission = admissions?.get(lastDatabase);
        if (!admission?.admit) throw new Error('Expected the retained deferred maintenance owner');
        const admit = admission.admit;
        const queued = Promise.withResolvers();
        // Observe the real sidecar scan entering its existing deferred admission.
        admission.admit = (operation) => {
          const pending = admit(operation);
          admission.admit = admit;
          queued.resolve();
          parentPort.postMessage({ type: 'fixture:maintenance-queued' });
          return pending;
        };
        const periodic = scheduled.periodic;
        scheduled.restore();
        triggered = true;
        void periodic();
        return queued.promise;
      };
      const on = parentPort.on;
      parentPort.on = function(event, listener) {
        return Reflect.apply(on, this, [event, event !== 'message' ? listener : function(...args) {
          const request = args[0];
          if (phase === 'before-request' && !triggered && fs.existsSync(${JSON.stringify(arm)}) && request?.type === 'reclaim') {
            void tick().then(() => Reflect.apply(listener, this, args));
            return;
          }
          return Reflect.apply(listener, this, args);
        }]);
      };
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) {
        lastDatabase = this;
        if (selected(this) && sql.startsWith('PRAGMA incremental_vacuum(') && fs.existsSync(${JSON.stringify(arm)})) {
          vacuumDatabase = this;
          record('vacuum', this);
        }
        if (!failed && vacuumDatabase === this && sql === 'COMMIT') {
          failed = this;
          record('commit', this);
          throw new Error('synthetic reclamation maintenance COMMIT failure');
        }
        if (failed === this && sql === 'ROLLBACK') {
          record('rollback', this);
          if (failRollback) throw new Error('synthetic reclamation maintenance ROLLBACK failure');
        }
        const value = exec.call(this, sql);
        if (phase === 'after-commit' && !triggered && sql === 'COMMIT' && selected(this) && fs.existsSync(${JSON.stringify(arm)})) tick();
        return value;
      };
      const close = DatabaseSync.prototype.close;
      DatabaseSync.prototype.close = function() {
        if (failed === this && failRollback) {
          record('close', this);
          if (unsafe) throw new Error('synthetic reclamation maintenance native close failure');
        }
        return close.call(this);
      };
      if (unsafe) process.on('uncaughtExceptionMonitor', () => {
        parentPort.postMessage({ type: 'fixture:native-exit-pending' });
        Atomics.wait(new Int32Array(workerData.fixtureNativeGate), 0, 0);
      });
    `,
  );
  const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  nativePreload.path = preload;
  nativePreload.gate = gate.buffer;
  nativePreload.moduleUrl = resolveRuntimeWorkerUrl(
    runtimeProcessEntrypoints.sessionTranscriptArchive,
  ).href;
  const leases = () =>
    state.db.prepare("SELECT lease_id FROM agent_database_leases ORDER BY lease_id").all();
  const foregroundLeases = leases();
  await reclaim();
  const worker = nativePreload.worker;
  if (!worker) {
    throw new Error("The actual reclamation Worker did not receive its native fixture");
  }
  expect(existsSync(capturedMaintenance)).toBe(true);
  const raw = new DatabaseSync(source.path);
  raw.exec(
    "INSERT INTO cache_entries(scope,key,value_json,blob,updated_at) VALUES ('maintenance-fixture','free-pages','{}',randomblob(4194304),1); DELETE FROM cache_entries WHERE scope='maintenance-fixture';",
  );
  expect(Number(raw.prepare("PRAGMA freelist_count").get()?.freelist_count)).toBeGreaterThan(512);
  raw.close();
  const retainedLeases = leases();
  expect(retainedLeases).toHaveLength(foregroundLeases.length + 1);
  const exiting = createDeferred();
  const maintenanceQueued = createDeferred();
  worker.on("message", (message: unknown) => {
    if (isRecord(message) && message.type === "fixture:native-exit-pending") {
      exiting.resolve();
    }
    if (isRecord(message) && message.type === "fixture:maintenance-queued") {
      maintenanceQueued.resolve();
    }
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    worker.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  writeFileSync(arm, "armed");
  let settled = false;
  const settle = (result: string) => {
    settled = true;
    return result;
  };
  const run = async () => {
    if (phase === "after-commit") {
      // The sidecar scan started by COMMIT finishes after that request's post-flush.
      // Its next admitted request must own maintenance and any native cleanup failure.
      await reclaim();
      await maintenanceQueued.promise;
    }
    return reclaim();
  };
  const outcome = run().then(
    () => settle("fulfilled"),
    () => settle("rejected"),
  );
  let probe: DatabaseSync | undefined;
  let follower: Promise<void> | undefined;
  const release = () => {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
  };
  try {
    const first = await Promise.race([
      outcome.then(() => "settled"),
      exiting.promise.then(() => "exiting"),
    ]);
    const events: unknown = JSON.parse(readFileSync(receipt, "utf8"));
    if (!Array.isArray(events)) {
      throw new Error("Native receipt was not an array");
    }
    const steps = ["vacuum", "commit", "rollback", ...(cleanup !== "rollback" ? ["close"] : [])];
    expect(events.slice(0, steps.length)).toEqual(
      steps.map((step) => ({ step, isOpen: true, isTransaction: true })),
    );
    probe = new DatabaseSync(source.path);
    probe.exec("PRAGMA busy_timeout = 0");
    if (unsafe) {
      expect(() => probe!.exec("BEGIN IMMEDIATE")).toThrow(/locked/u);
      expect(first, "unsettled reclamation must retain admission until native exit").toBe(
        "exiting",
      );
      expect([settled, exited, leases()]).toEqual([false, false, retainedLeases]);
      let followed = false;
      follower = runOpenClawAgentWriteAdmission(databaseOptions, () => {
        expect(exited).toBe(true);
        followed = true;
      });
      await setImmediate();
      expect(followed).toBe(false);
      release();
      expect(await outcome).toBe("rejected");
      await follower;
      await exit;
      expect(leases()).toEqual(foregroundLeases);
    } else {
      expect(await outcome).toBe(cleanup === "close" ? "rejected" : "fulfilled");
    }
    probe.exec("BEGIN IMMEDIATE");
    probe.exec("ROLLBACK");
  } finally {
    release();
    if (unsafe) {
      await worker.terminate();
    }
    await Promise.allSettled([outcome, follower]);
    probe?.close();
  }
});
