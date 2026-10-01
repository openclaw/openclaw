import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { onSqliteWalCheckpoint } from "./sqlite-wal-checkpoint.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawStateDatabaseForTest();
});

it.each(["keep", "close", "replace"] as const)(
  "admits one bounded periodic pass on the published agent handle (%s)",
  async (retirement) => {
    const root = tempDirs.make("openclaw-agent-wal-admission-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      openOpenClawStateDatabase();
      const intervals = vi.spyOn(globalThis, "setInterval");
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const timers = intervals.mock.calls.filter(([, delay]) => delay === 30 * 60 * 1000);
      intervals.mockRestore();
      expect(timers).toHaveLength(1);
      const periodic = timers[0]?.[0];
      if (typeof periodic !== "function") {
        throw new Error("Expected the published agent's maintenance timer");
      }
      database.db
        .prepare(
          "INSERT INTO cache_entries(scope, key, value_json, blob, updated_at) VALUES ('wal-proof', 'pages', '{}', randomblob(4194304), 1)",
        )
        .run();
      database.db.prepare("DELETE FROM cache_entries WHERE scope = 'wal-proof'").run();
      const freePages = () =>
        Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count);
      const before = freePages();
      expect(before).toBeGreaterThan(512);
      const tickReclaimed = createDeferredCore();
      let foreground: Promise<void> | undefined;
      let foregroundFreePages = 0;
      const exec = vi.spyOn(database.db, "exec");
      const prepare = vi.spyOn(database.db, "prepare");
      const vacuumCalls = () =>
        exec.mock.calls.filter(([sql]) => sql.startsWith("PRAGMA incremental_vacuum("));
      const checkpointCalls = () =>
        prepare.mock.calls.filter(([sql]) => sql.startsWith("PRAGMA wal_checkpoint("));
      const options = { agentId: "main", path: database.path };
      const unobserve = onSqliteWalCheckpoint((observation) => {
        if (observation.databasePath !== database.path || retirement !== "keep") {
          return;
        }
        if (observation.health.state === "error") {
          tickReclaimed.reject(
            new Error(observation.health.error ?? "Periodic WAL maintenance failed"),
          );
          return;
        }
        const remaining = freePages();
        if (remaining <= before - 512) {
          tickReclaimed.resolve();
        } else if (remaining < before && !foreground) {
          foreground = runOpenClawAgentWriteAdmission(options, () => {
            foregroundFreePages = freePages();
          });
        }
      });
      try {
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const reservation = runOpenClawAgentWorkerWrite(options, async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
        try {
          periodic();
          periodic();
          periodic();
          expect(vacuumCalls()).toHaveLength(0);
          expect(checkpointCalls()).toHaveLength(0);
          expect(freePages()).toBe(before);
          if (retirement !== "keep") {
            expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
            if (retirement === "replace") {
              const replacement = openOpenClawAgentDatabase(options);
              expect(replacement.db.isOpen).toBe(true);
              expect(replacement.db === database.db).toBe(false);
            }
          }
        } finally {
          release.resolve();
          await reservation;
          if (retirement === "keep") {
            await tickReclaimed.promise;
          }
          await runOpenClawAgentWriteAdmission(options, () => undefined);
          await foreground;
        }
        if (retirement === "keep") {
          expect(vacuumCalls()).toEqual([]);
          expect(checkpointCalls()).toEqual([]);
          expect(database.walMaintenance.health).toMatchObject({
            state: "complete",
            warning: false,
          });
          const reclaimed = before - freePages();
          expect(reclaimed).toBe(512);
          expect(foregroundFreePages).toBeGreaterThan(before - 512);
          expect(foregroundFreePages).toBeLessThan(before);
          const reader = openNodeSqliteDatabase(database.path, { readOnly: true });
          try {
            reader.exec("BEGIN");
            reader.prepare("SELECT COUNT(*) FROM cache_entries").get();
            database.db
              .prepare(
                "INSERT INTO cache_entries(scope,key,blob,updated_at) VALUES('wal-proof','held',zeroblob(4096),1)",
              )
              .run();
            const heldFreePages = freePages();
            for (const expectedState of ["blocked", "blocked", "complete"] as const) {
              if (expectedState === "complete") {
                reader.exec("ROLLBACK");
              }
              const observed = createDeferredCore();
              const stop = onSqliteWalCheckpoint((event) => {
                if (event.databasePath === database.path) {
                  observed.resolve();
                }
              });
              try {
                periodic();
                await observed.promise;
                expect(database.walMaintenance.health?.state).toBe(expectedState);
                if (expectedState === "blocked") {
                  expect(freePages()).toBe(heldFreePages);
                }
              } finally {
                stop();
              }
              // Let the original scheduler settle before triggering the next interval.
              await runOpenClawAgentWriteAdmission(options, () => undefined);
            }
            expect(checkpointCalls()).toEqual([]);
            expect(vacuumCalls()).toEqual([]);
          } finally {
            reader.close();
          }
        } else {
          expect(vacuumCalls()).toEqual([]);
        }
      } finally {
        unobserve();
      }
    });
  },
);

const workerSource = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const messages = [];
  let receiver;
  parentPort.on("message", (message) => {
    if (receiver) {
      const resolve = receiver;
      receiver = undefined;
      resolve(message);
    } else messages.push(message);
  });
  const receive = () => messages.length
    ? Promise.resolve(messages.shift())
    : new Promise((resolve) => { receiver = resolve; });
  (async () => {
    const { register } = await import(workerData.loader);
    register();
    const agent = await import(workerData.agentModule);
    const state = await import(workerData.stateModule);
    state.openOpenClawStateDatabase();
    const nativeInterval = globalThis.setInterval;
    let periodic;
    globalThis.setInterval = (callback, delay, ...args) => {
      if (delay === 30 * 60 * 1000) periodic = () => callback(...args);
      return nativeInterval(callback, delay, ...args);
    };
    let phase = "opening";
    let admitted = false;
    let authorized = true;
    const withAdmission = async (run) => {
      parentPort.postMessage({ type: "request", phase });
      const permit = await receive();
      if (permit.type !== "permit") throw new Error("Expected parent write admission");
      admitted = true;
      authorized = true;
      try {
        return await run(() => {
          if (!authorized) throw new Error("Worker operation authority revoked");
        });
      }
      finally {
        admitted = false;
        if (phase !== "close") parentPort.postMessage({ type: "release" });
      }
    };
    let database;
    await agent.withOpenClawAgentDatabaseAdmission(workerData.options, withAdmission, (opened) => {
      database = opened;
    });
    globalThis.setInterval = nativeInterval;
    if (!periodic) throw new Error("Expected the retained Worker database timer");
    const nativeExec = database.db.exec.bind(database.db);
    const withinAdmission = [];
    database.db.exec = (sql) => {
      if (sql.startsWith("PRAGMA incremental_vacuum(")) withinAdmission.push(admitted);
      return nativeExec(sql);
    };
    parentPort.postMessage({ type: "ready" });
    const command = await receive();
    if (command.type !== "tick") throw new Error("Expected timer command");
    if (!workerData.revoke) { periodic(); periodic(); periodic(); }
    parentPort.postMessage({ type: "ticked", count: withinAdmission.length });
    if (!workerData.retire) {
      phase = "flush";
      await agent.withOpenClawAgentDatabaseAdmission(workerData.options, withAdmission, async () => {
        if (workerData.revoke) {
          periodic();
          await Promise.resolve();
          authorized = false;
        }
      });
    }
    phase = "close";
    await withAdmission(() => {
      const cleanup = agent.settleOpenClawAgentDatabaseWorkerClose(database.path);
      if (!cleanup.settled) throw new Error("Worker database cleanup did not settle");
      state.closeOpenClawStateDatabaseForTest();
    });
    parentPort.postMessage({ type: "result", withinAdmission });
    parentPort.close();
  })().catch((error) => {
    parentPort.postMessage({ type: "failure", message: error.message });
    process.exitCode = 1;
    parentPort.close();
  });
`;

it.each([
  { retire: false, revoke: false },
  { retire: true, revoke: false },
  { retire: false, revoke: true },
])(
  "keeps retained Worker timer writes inside parent admission (retire: $retire, revoke: $revoke)",
  async ({ retire, revoke }) => {
    const root = tempDirs.make("openclaw-worker-wal-admission-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const initialized = openOpenClawAgentDatabase({ agentId: "main" });
      initialized.db.exec(`INSERT INTO cache_entries(scope, key, blob, updated_at)
        VALUES ('wal-proof', 'pages', zeroblob(4194304), 1);
        DELETE FROM cache_entries WHERE scope = 'wal-proof';`);
      const options = {
        agentId: "main",
        path: initialized.path,
        env: { OPENCLAW_STATE_DIR: root },
      };
      closeOpenClawAgentDatabaseByPath(initialized.path);
      const worker = new Worker(workerSource, {
        eval: true,
        execArgv: [],
        workerData: {
          options,
          retire,
          revoke,
          loader: import.meta.resolve("tsx/esm/api"),
          agentModule: new URL("../state/openclaw-agent-db.ts", import.meta.url).href,
          stateModule: new URL("../state/openclaw-state-db.ts", import.meta.url).href,
        },
      });
      const ready = createDeferredCore();
      const ticked = createDeferredCore<number>();
      const requested = createDeferredCore();
      const result = createDeferredCore<boolean[]>();
      const admissions: Promise<void>[] = [];
      const exited = new Promise<number>((resolve) => {
        worker.once("exit", resolve);
      });
      const fail = (error: Error) => {
        ready.reject(error);
        ticked.reject(error);
        requested.reject(error);
        result.reject(error);
      };
      for (const deferred of [ready, ticked, requested, result]) {
        void deferred.promise.catch(() => {});
      }
      worker.once("error", fail);
      let releaseAdmission: (() => void) | undefined;
      worker.on("message", (message) => {
        if (message.type === "request") {
          const released = createDeferredCore();
          const admission = runOpenClawAgentWorkerWrite(options, async () => {
            if (worker.threadId === -1) {
              return;
            }
            releaseAdmission = released.resolve;
            worker.postMessage({ type: "permit" }, []);
            await (message.phase === "close" ? exited : Promise.race([released.promise, exited]));
          });
          admissions.push(admission);
          void admission.catch(fail);
          if (message.phase !== "opening") {
            requested.resolve();
          }
        } else if (message.type === "release") {
          releaseAdmission?.();
        } else if (message.type === "ready") {
          ready.resolve();
        } else if (message.type === "ticked") {
          ticked.resolve(message.count);
        } else if (message.type === "result") {
          result.resolve(message.withinAdmission);
        } else if (message.type === "failure") {
          fail(new Error(message.message));
        }
      });
      const release = createDeferredCore();
      let holding: Promise<void> | undefined;
      try {
        await ready.promise;
        const entered = createDeferredCore();
        holding = runOpenClawAgentWorkerWrite(options, async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
        worker.postMessage({ type: "tick" }, []);
        expect(await ticked.promise).toBe(0);
        await requested.promise;
        release.resolve();
        await holding;
        expect(await result.promise).toEqual(retire || revoke ? [] : [true]);
        expect(await exited).toBe(0);
      } finally {
        release.resolve();
        await holding;
        await worker.terminate();
        await Promise.allSettled([exited, ...admissions]);
      }
    });
  },
);
