import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { captureResourceOwnedNativeWorkerExit } from "../../infra/vitest-resource-ownership.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import {
  createLifecycleArtifactReclamationPlan,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";

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
        super(
          filename,
          selected
            ? {
                ...options,
                execArgv: [...(options?.execArgv ?? []), "--require", nativePreload.path],
                workerData: { ...options?.workerData, fixtureNativeGate: nativePreload.gate },
              }
            : options,
        );
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
    nativePreload.path = "";
    nativePreload.moduleUrl = "";
    nativePreload.worker = undefined;
    nativePreload.gate = undefined;
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

describe.skipIf(Boolean(process.versions.bun))(
  "reclamation deferred maintenance native custody",
  () => {
    it.each([
      { phase: "pre", cleanup: "rollback" },
      { phase: "pre", cleanup: "close" },
      { phase: "pre", cleanup: "unsettled" },
      { phase: "post", cleanup: "rollback" },
      { phase: "post", cleanup: "close" },
      { phase: "post", cleanup: "unsettled" },
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
      const plan = () =>
        createLifecycleArtifactReclamationPlan({
          agentId: options.agentId,
          databaseOptions,
          entries: [],
          materializedPlans: [],
        });
      const arm = path.join(root, "armed");
      const capturedTimer = path.join(root, "captured-timer");
      const receipt = path.join(root, "native-events.json");
      const preload = path.join(root, "deferred-maintenance.cjs");
      writeFileSync(
        preload,
        `
      const fs = require('node:fs');
      const { DatabaseSync } = require('node:sqlite');
      const { parentPort, workerData } = require('node:worker_threads');
      const target = ${JSON.stringify(realpathSync(source.path))};
      const phase = ${JSON.stringify(phase)};
      const unsafe = ${JSON.stringify(unsafe)};
      const failRollback = ${JSON.stringify(cleanup !== "rollback")};
      const events = [];
      let lastDatabase, periodic, triggered = false, vacuumDatabase, failed;
      const selected = (db) => {
        const location = db.location();
        return location && fs.realpathSync(location) === target;
      };
      const record = (step, db) => {
        events.push({ step, isOpen: db.isOpen, isTransaction: db.isTransaction });
        fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(events));
      };
      const tick = () => {
        if (triggered) return;
        if (!periodic) throw new Error('The real source maintenance timer was not captured');
        triggered = true;
        periodic();
      };
      const on = parentPort.on;
      parentPort.on = function(event, listener) {
        return Reflect.apply(on, this, [event, event !== 'message' ? listener : function(...args) {
          const request = args[0];
          if (phase === 'pre' && fs.existsSync(${JSON.stringify(arm)}) && request?.type === 'reclaim') tick();
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
        if (phase === 'post' && !triggered && sql === 'COMMIT' && selected(this) && fs.existsSync(${JSON.stringify(arm)})) tick();
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
      const interval = globalThis.setInterval;
      globalThis.setInterval = function(callback, delay, ...args) {
        const timer = interval(callback, delay, ...args);
        if (delay === 30 * 60 * 1000 && lastDatabase && selected(lastDatabase)) {
          periodic = () => callback(...args);
          fs.writeFileSync(${JSON.stringify(capturedTimer)}, 'captured');
        }
        return timer;
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
      await runSqliteSessionReclamation({
        forceInProcess: false,
        plan: plan(),
        assertCommitAllowed: () => {},
      });
      const worker = nativePreload.worker;
      if (!worker) {
        throw new Error("The actual reclamation Worker did not receive its native fixture");
      }
      const settleNativeExit = unsafe ? captureResourceOwnedNativeWorkerExit(worker) : undefined;
      expect(existsSync(capturedTimer)).toBe(true);
      const raw = new DatabaseSync(source.path);
      raw.exec(
        "INSERT INTO cache_entries(scope,key,value_json,blob,updated_at) VALUES ('maintenance-fixture','free-pages','{}',randomblob(4194304),1); DELETE FROM cache_entries WHERE scope='maintenance-fixture';",
      );
      expect(Number(raw.prepare("PRAGMA freelist_count").get()?.freelist_count)).toBeGreaterThan(
        512,
      );
      raw.close();
      const retainedLeases = leases();
      expect(retainedLeases).toHaveLength(foregroundLeases.length + 1);
      const exiting = createDeferred();
      worker.on("message", (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "fixture:native-exit-pending"
        ) {
          exiting.resolve();
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
      const outcome = runSqliteSessionReclamation({
        forceInProcess: false,
        plan: plan(),
        assertCommitAllowed: () => {},
      }).then(
        (value) => {
          settled = true;
          return { status: "fulfilled", value };
        },
        (error: unknown) => {
          settled = true;
          return { status: "rejected", error };
        },
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
        expect(events.slice(0, cleanup !== "rollback" ? 4 : 3)).toEqual([
          { step: "vacuum", isOpen: true, isTransaction: true },
          { step: "commit", isOpen: true, isTransaction: true },
          { step: "rollback", isOpen: true, isTransaction: true },
          ...(cleanup !== "rollback" ? [{ step: "close", isOpen: true, isTransaction: true }] : []),
        ]);
        probe = new DatabaseSync(source.path);
        probe.exec("PRAGMA busy_timeout = 0");
        if (unsafe) {
          expect(() => probe!.exec("BEGIN IMMEDIATE")).toThrow(/locked/u);
          expect(first, "unsettled reclamation must retain admission until native exit").toBe(
            "exiting",
          );
          expect(settled).toBe(false);
          expect(exited).toBe(false);
          expect(leases()).toEqual(retainedLeases);
          let followed = false;
          follower = runOpenClawAgentWriteAdmission(databaseOptions, () => {
            expect(exited).toBe(true);
            followed = true;
          });
          await setImmediate();
          expect(followed).toBe(false);
          release();
          expect((await outcome).status).toBe("rejected");
          await follower;
          await exit;
          expect(leases()).toEqual(foregroundLeases);
        } else {
          expect((await outcome).status).toBe(
            phase === "pre" && cleanup === "close" ? "rejected" : "fulfilled",
          );
        }
        probe.exec("BEGIN IMMEDIATE");
        probe.exec("ROLLBACK");
      } finally {
        release();
        if (unsafe) {
          await worker.terminate();
          await settleNativeExit?.();
        }
        await Promise.allSettled([outcome, follower]);
        probe?.close();
      }
    });
  },
);
