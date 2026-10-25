import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, assert, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as configEnv from "../config/config-env-vars.js";
import {
  createSessionEntryWithTranscript,
  prepareSessionEntryMutationDatabases,
} from "../config/sessions/session-accessor.entry-mutation.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  costRefreshLane,
  retireSessionHistoryWorkerDatabases,
} from "../config/sessions/session-transcript-worker-resources.js";
import { closeAgentWorkAdmissions } from "../sessions/session-controller.lifecycle.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
import * as agentExecution from "../state/openclaw-agent-execution.js";
import * as writerAdmission from "../state/openclaw-agent-write-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { refreshCostUsageCacheForAgent as refreshUsage } from "./session-cost-usage-aggregation.js";
import {
  acquireUsageLock,
  createUsageCacheWrite as rollupRow,
  disposableUsageLock as disposableLock,
} from "./session-cost-usage-cache.fixtures.test-support.js";
import { writeSessionCostUsageRollupsInDatabase as writeRollups } from "./session-cost-usage-cache.kernel.js";
import {
  isSessionCostUsageRefreshRunning as isRefreshing,
  prepareSessionCostUsageRefreshLock as prepareLock,
} from "./session-cost-usage-cache.sqlite.js";
import {
  pruneUsageCostRollupsForTest as pruneRows,
  readSessionCostUsageRollupRows as readRows,
} from "./session-cost-usage-cache.test-support.js";
import { openUsageCostRefreshFailures } from "./session-cost-usage-refresh-health.js";
import { withSessionCostUsageWorkerDatabases as withUsageDatabases } from "./session-cost-usage-worker-scope.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "./sqlite-database-admission.js";
import * as integrityWorker from "./sqlite-integrity-worker.js";
import { WorkerTaskPool } from "./worker-task-pool.js";
import type { WorkerTaskInput, WorkerTaskOptions } from "./worker-task-pool.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function holdWriter(options: Parameters<typeof writerAdmission.runOpenClawAgentWorkerWrite>[0]) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const reservation = writerAdmission.runOpenClawAgentWorkerWrite(options, async () => {
    entered.resolve();
    await release.promise;
  });
  return { entered, release, reservation };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawStateDatabaseForTest();
});

it("records all uncommitted rollups when a scan fails before publication", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-uncommitted-health";
    const sessionFiles = ["a", "b"].map((id) => state.path(`${id}.jsonl`));
    for (const file of sessionFiles) {
      fs.writeFileSync(file, "{}\n");
    }
    // oxlint-disable-next-line typescript/unbound-method -- The observer forwards the pool receiver.
    const run = WorkerTaskPool.prototype.run;
    const observer = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(function (
      this: WorkerTaskPool<unknown, unknown>,
      input: WorkerTaskInput<unknown>,
      options: WorkerTaskOptions<unknown>,
    ) {
      const onRequest = options.onRequest;
      if (!onRequest) {
        return run.call(this, input, options);
      }
      return run.call(this, input, {
        ...options,
        onRequest: async (_value, context) => {
          // Exercise the host's scan-failure boundary without a wall-clock-dependent batch.
          for (const sessionFile of sessionFiles) {
            await onRequest({ kind: "refresh-session", input: { sessionFile } }, context);
          }
          throw new Error("synthetic scan failure");
        },
      });
    });
    try {
      await expect(refreshUsage({ config: {}, agentId, sessionFiles })).rejects.toThrow(
        "synthetic scan failure",
      );
    } finally {
      observer.mockRestore();
    }
    expect(readRows(agentId)).toEqual([]);
    const failures = await openUsageCostRefreshFailures(state.env).entries();
    expect(failures.map(({ value }) => value.sessionFile).toSorted()).toEqual(sessionFiles);
  });
});

it.each(["rollup", "prune"] as const)(
  "queues warm usage %s behind the active writer reservation",
  async (operation) => {
    const root = tempDirs.make("openclaw-usage-writer-reservation-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const agentId = "usage-test";
      const database = openOpenClawAgentDatabase({ agentId });
      const databasePath = database.path;
      runOpenClawAgentWriteTransaction(
        ({ db }) => writeRollups(db, [rollupRow("session.jsonl", '{"totalTokens":1}', 1)]),
        { agentId, path: databasePath },
        { operationLabel: "session-cost-usage.rollup.write" },
      );
      let lock: ReturnType<typeof prepareLock> | undefined;
      if (operation === "rollup") {
        lock = prepareLock(agentId, databasePath);
        expect(await lock.acquire()).toBe(true);
      }
      const readLock = () =>
        database.db
          .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
          .get("session-cost-usage", "refresh-lock");
      const readSnapshot = () => ({ lock: readLock(), rows: readRows(agentId, databasePath) });
      const before = readSnapshot();
      const { entered, release, reservation } = holdWriter({ agentId, path: databasePath });
      await entered.promise;
      let settled = false;
      const writing = (async () => {
        switch (operation) {
          case "rollup":
            expect(
              await lock!.writeRollup([rollupRow("session.jsonl", '{"totalTokens":2}', 2)]),
            ).toBe(true);
            break;
          case "prune":
            await pruneRows({ agentId, databasePath, rows: before.rows, liveKeys: new Set() });
            break;
        }
      })().finally(() => {
        settled = true;
      });
      const written = Promise.allSettled([writing]);
      try {
        try {
          await setImmediate();
          expect(readSnapshot()).toEqual(before);
          expect(settled).toBe(false);
        } finally {
          release.resolve();
          await reservation;
          await written;
        }
        await expect(writing).resolves.toBeUndefined();
        expect(readRows(agentId, databasePath)).toEqual(
          operation === "prune"
            ? []
            : [
                {
                  key: "session.jsonl",
                  valueJson: '{"totalTokens":2}',
                  updatedAt: 2,
                  bodyBytes: 0,
                },
              ],
        );
      } finally {
        await lock?.release();
      }
    });
  },
);

it.each([
  { closing: true, retarget: false, refresh: false },
  { closing: false, retarget: true, refresh: false },
  { closing: false, retarget: true, refresh: true },
])(
  "joins pending native admission before a usage write (closing=$closing, retarget=$retarget, refresh=$refresh)",
  async ({ closing, retarget, refresh }) => {
    const root = tempDirs.make("openclaw-usage-admission-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const agentId = "usage-test";
      const databasePath = openOpenClawAgentDatabase({ agentId }).path;
      closeOpenClawAgentDatabasesForTest();
      revokeSqliteDatabaseAdmissionsForPath(databasePath);
      const cwd = retarget
        ? vi.spyOn(process, "cwd").mockReturnValue(path.dirname(databasePath))
        : undefined;
      const retargeted = path.join(root, "other-cwd");
      if (retarget) {
        fs.mkdirSync(retargeted);
      }
      const sessionsDir = path.join(root, "sessions");
      const sessionFile = path.join(sessionsDir, "session.jsonl");
      if (refresh) {
        fs.mkdirSync(sessionsDir);
        fs.writeFileSync(
          sessionFile,
          JSON.stringify({ message: { role: "user", content: "hello" } }),
        );
      }
      const cachePath = retarget ? path.basename(databasePath) : databasePath;
      const nativeFinished = createDeferredCore();
      const release = createDeferredCore();
      const check = integrityWorker.assertSqliteIntegrityInWorker;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (...args) => {
          try {
            await check(...args);
            nativeFinished.resolve();
            await release.promise;
          } catch (error) {
            nativeFinished.reject(error);
            throw error;
          }
        },
      );
      const opening = withOpenClawAgentDatabaseAsync(
        { agentId, path: databasePath },
        () => undefined,
      );
      const opened = Promise.allSettled([opening]);
      const lock = refresh ? undefined : prepareLock(agentId, cachePath);
      let writeSettled = false;
      const writing = Promise.resolve()
        .then(async () => {
          if (!lock) {
            return await refreshUsage({
              agentId,
              databasePath: cachePath,
              storePath: path.join(sessionsDir, "sessions.json"),
              agentDir: path.join(root, "agent-config"),
            });
          }
          try {
            expect(await lock.acquire()).toBe(true);
            return await lock.writeRollup([rollupRow()]);
          } finally {
            await lock.release();
          }
        })
        .finally(() => {
          writeSettled = true;
        });
      const written = Promise.allSettled([writing]);
      let drain: Promise<void> | undefined;
      let drained = false;
      try {
        await nativeFinished.promise;
        await setImmediate();
        expect(writeSettled).toBe(false);
        expect(readRows(agentId, databasePath)).toEqual([]);
        cwd?.mockReturnValue(retargeted);
        if (closing) {
          drain = closeOpenClawAgentDatabasesAsync(root).then(() => {
            drained = true;
          });
          await setImmediate();
          expect(drained).toBe(false);
        }
        release.resolve();
        await opened;
        const [outcome] = await written;
        if (closing) {
          await drain;
          expect(outcome.status).toBe("rejected");
          expect(readRows(agentId, databasePath)).toEqual([]);
        } else {
          expect(outcome).toEqual({ status: "fulfilled", value: refresh ? "refreshed" : true });
          expect(fs.existsSync(path.join(retargeted, path.basename(databasePath)))).toBe(false);
          const rows = readRows(agentId, databasePath);
          if (refresh) {
            expect(rows.map((row) => row.key)).toEqual([sessionFile]);
          } else {
            expect(rows).toEqual([
              { key: "session.jsonl", valueJson: '{"totalTokens":7}', updatedAt: 1, bodyBytes: 0 },
            ]);
          }
        }
      } finally {
        release.resolve();
        await opened;
        await written;
        await drain;
      }
    });
  },
);

it.each([false, true])(
  "drains retained usage cleanup by captured path before physical retirement (retry=%s)",
  async (retry) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentId = "usage-deletion";
      const selected = openOpenClawAgentDatabase({ agentId, env: state.env });
      const otherEnv = { ...state.env, OPENCLAW_STATE_DIR: state.path("other-state") };
      const other = openOpenClawAgentDatabase({ agentId, env: otherEnv });
      const aliasDirectory = state.path("selected-agent");
      fs.symlinkSync(path.dirname(selected.path), aliasDirectory, "junction");
      const alias = path.join(aliasDirectory, path.basename(selected.path));
      const finish = createDeferredCore();
      const ready = createDeferredCore();
      let cleaned = 0;
      let otherCleaned = false;
      const failure = new Error("Refresh cleanup temporarily failed");
      let cleanupFailure = retry ? failure : undefined;
      const readingFromOtherState = withUsageDatabases(
        [{ agentId, path: selected.path, env: otherEnv }],
        async () => await finish.promise,
      );
      const read = Promise.allSettled([readingFromOtherState]);
      const target = { agentId, path: selected.path, env: state.env, requestedPaths: [alias] };
      const holding = withUsageDatabases([target], async (scope) => {
        const lock = prepareLock(agentId, selected.path, { env: state.env });
        scope.retainCleanup(async () => {
          if (cleanupFailure) {
            throw cleanupFailure;
          }
          await lock.release();
          cleaned++;
        });
        expect(await lock.acquire()).toBe(true);
        ready.resolve();
        await finish.promise;
      });
      const held = Promise.allSettled([holding]);
      const otherReady = createDeferredCore();
      const holdingOther = withUsageDatabases(
        [{ agentId, path: other.path, env: otherEnv }],
        async (scope) => {
          scope.retainCleanup(async () => {
            otherCleaned = true;
          });
          otherReady.resolve();
          await finish.promise;
        },
      );
      const otherHeld = Promise.allSettled([holdingOther]);
      let reopen: (() => void) | undefined;
      try {
        await awaitGateBeforeSettlement(ready.promise, holding, "Usage lock did not acquire");
        await awaitGateBeforeSettlement(
          otherReady.promise,
          holdingOther,
          "Sibling scope did not open",
        );
        reopen = closeAgentWorkAdmissions({
          agentId,
          env: state.env,
          reason: new Error("Agent deletion is draining active work"),
        });
        const selection = { agentId, paths: [alias, selected.path, alias] };
        if (retry) {
          await expect(retireSessionHistoryWorkerDatabases(selection)).rejects.toMatchObject({
            errors: [failure],
          });
          await expect(withUsageDatabases([target], async () => undefined)).rejects.toThrow(
            "Session database work is still draining",
          );
          cleanupFailure = undefined;
        }
        await retireSessionHistoryWorkerDatabases(selection);
        expect(cleaned).toBe(1);
        expect(otherCleaned).toBe(false);
        expect(
          selected.db
            .prepare("SELECT key FROM cache_entries WHERE scope = ? AND key = ?")
            .get("session-cost-usage", "refresh-lock"),
        ).toBeUndefined();
        await closeOpenClawAgentDatabaseByPathAsync(selected.path, agentId);
        expect(otherCleaned).toBe(false);
        finish.resolve();
        await expect(holding).rejects.toThrow("Session usage database work was revoked");
        await expect(readingFromOtherState).rejects.toThrow(
          "Session usage database work was revoked",
        );
        await expect(holdingOther).resolves.toBeUndefined();
        expect(otherCleaned).toBe(true);
        expect(cleaned).toBe(1);
        await expect(withUsageDatabases([target], async () => undefined)).resolves.toBeUndefined();
      } finally {
        cleanupFailure = undefined;
        finish.resolve();
        await held;
        await read;
        await otherHeld;
        reopen?.();
      }
    });
  },
);

it.for(["rollup", "prune"] as const)(
  "cancels a queued usage %s before the active writer settles",
  async (operation, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentId = "usage-canceled-admission";
      const options = { agentId, env: state.env };
      const database = openOpenClawAgentDatabase(options);
      const owner = await acquireUsageLock(agentId, database.path, { env: state.env });
      const row = rollupRow("retained", "{}");
      expect(await owner.writeRollup([row])).toBe(true);
      const before = readRows(agentId, database.path);
      const { entered, release, reservation: held } = holdWriter(options);
      await entered.promise;
      const controller = new AbortController();
      const cancellation = new Error("Usage callback deadline expired");
      const writing =
        operation === "rollup"
          ? owner.writeRollup([{ ...row, rollupId: "canceled" }], controller.signal)
          : owner.pruneRows(before, controller.signal);
      const outcome = writing.then(
        () => undefined,
        (error: unknown) => error,
      );
      controller.abort(cancellation);
      try {
        expect(await withinTest(outcome, signal)).toBe(cancellation);
        expect(readRows(agentId, database.path)).toEqual(before);
      } finally {
        release.resolve();
        await Promise.allSettled([held, writing]);
        await owner.release();
      }
      expect(readRows(agentId, database.path)).toEqual(before);
    });
  },
);

it("rejects a queued rollup after its refresh authority is revoked", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-revoked-write";
    const options = { agentId, env: state.env };
    const database = openOpenClawAgentDatabase(options);
    let current = true;
    const owner = prepareLock(agentId, database.path, {
      env: state.env,
      assertCurrent() {
        if (!current) {
          throw new Error("Refresh revoked");
        }
      },
    });
    expect(await owner.acquire()).toBe(true);
    const { entered, release, reservation } = holdWriter(options);
    await entered.promise;
    const writing = owner.writeRollup([rollupRow("revoked", "{}")]);
    const rejected = expect(writing).rejects.toThrow("Refresh revoked");
    current = false;
    release.resolve();
    try {
      await reservation;
      await rejected;
      expect(readRows(agentId, database.path)).toEqual([]);
    } finally {
      await owner.release();
    }
    expect(await isRefreshing(agentId, database.path)).toBe(false);
  });
});

it("releases the acquired refresh lock after the caller changes its state directory", async () => {
  const originalRoot = tempDirs.make("openclaw-usage-lock-origin-");
  const otherRoot = tempDirs.make("openclaw-usage-lock-other-");
  const agentId = "usage-test";
  await withEnvAsync({ OPENCLAW_STATE_DIR: originalRoot }, async () => {
    const databasePath = openOpenClawAgentDatabase({ agentId }).path;
    await using original = await acquireUsageLock(agentId);
    await withEnvAsync({ OPENCLAW_STATE_DIR: otherRoot }, async () => {
      await using other = disposableLock(agentId);
      expect(await other.acquire()).toBe(true);
      await original.release();
      expect(await isRefreshing(agentId, databasePath)).toBe(false);
      expect(await isRefreshing(agentId)).toBe(true);
    });
  });
});

it("keeps usage exclusion in its mixed-case Windows state root", async () => {
  await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
    const agentId = "usage-test";
    const options = { agentId, env: state.env };
    const database = openOpenClawAgentDatabase(options);
    const shared = openOpenClawStateDatabase({ env: state.env });
    const registry = () =>
      shared.db.prepare("SELECT agent_id, path FROM agent_databases ORDER BY agent_id, path").all();
    const beforeRegistry = registry();
    const readLock = () =>
      database.db
        .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
        .get("session-cost-usage", "refresh-lock");
    const defaultRoot = path.join(state.home, ".openclaw");
    const laterRoot = state.path("later-state");
    expect(fs.existsSync(defaultRoot)).toBe(false);
    expect(fs.existsSync(laterRoot)).toBe(false);
    const originalEnv = process.env;
    const hostPlatform = process.platform;
    const mixedCaseEnv = { ...originalEnv };
    for (const key of Object.keys(mixedCaseEnv)) {
      if (key.toUpperCase() === "OPENCLAW_STATE_DIR") {
        delete mixedCaseEnv[key];
      }
    }
    mixedCaseEnv.OpenClaw_State_Dir = state.stateDir;
    const cloneEnv = configEnv.cloneEnvWithPlatformSemantics;
    expect(mixedCaseEnv.OPENCLAW_STATE_DIR).toBeUndefined();
    expect(withMockedPlatform("win32", () => cloneEnv(mixedCaseEnv)).OPENCLAW_STATE_DIR).toBe(
      state.stateDir,
    );
    const clone = vi.spyOn(configEnv, "cloneEnvWithPlatformSemantics").mockImplementation((input) =>
      // Only the pure clone sees Windows; path resolution and SQLite use the real host.
      withMockedPlatform("win32", () => cloneEnv(input)),
    );
    const { entered, release, reservation } = holdWriter({ ...options, path: database.path });
    let owner: ReturnType<typeof prepareLock> | undefined;
    let acquiring: Promise<boolean> | undefined;
    let acquired = false;
    try {
      await entered.promise;
      process.env = mixedCaseEnv;
      owner = prepareLock(agentId);
      acquiring = owner.acquire().then((granted) => {
        acquired = granted;
        return granted;
      });
      void acquiring.catch(() => {});
      process.env = { ...originalEnv, OPENCLAW_STATE_DIR: laterRoot };
      expect(process.platform).toBe(hostPlatform);
      await setImmediate();
      expect(readLock()).toBeUndefined();
      expect(acquired).toBe(false);
      release.resolve();
      await reservation;
      expect(await acquiring).toBe(true);
      expect(readLock()).toBeUndefined();
      expect(await isRefreshing(agentId, database.path)).toBe(true);
      expect(registry()).toEqual(beforeRegistry);
      expect(fs.existsSync(defaultRoot)).toBe(false);
      expect(fs.existsSync(laterRoot)).toBe(false);
      await owner.release();
      expect(readLock()).toBeUndefined();
      expect(registry()).toEqual(beforeRegistry);
      expect(fs.existsSync(defaultRoot)).toBe(false);
      expect(fs.existsSync(laterRoot)).toBe(false);
    } finally {
      process.env = originalEnv;
      release.resolve();
      await Promise.allSettled([reservation, acquiring]);
      try {
        await owner?.release();
      } finally {
        clone.mockRestore();
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
      }
    }
  });
});

it("finishes a foreground session write while pruning a cold existing usage store", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "main";
    const template = openOpenClawAgentDatabase({ agentId, env: state.env });
    runOpenClawAgentWriteTransaction(
      ({ db }) => writeRollups(db, [rollupRow("removed-session.jsonl")]),
      { agentId, path: template.path, env: state.env },
      { operationLabel: "session-cost-usage.rollup.write" },
    );
    await closeOpenClawAgentDatabaseByPathAsync(template.path, agentId);
    const storePath = state.statePath("cold-usage.sqlite");
    // A closed snapshot gives the reader an existing file with no process admission yet.
    fs.copyFileSync(template.path, storePath);
    const scope = { agentId, sessionKey: `agent:${agentId}:first`, storePath, env: state.env };
    const entry = { sessionId: "created-during-prune", updatedAt: 1 };
    const dispatchReady = createDeferredCore();
    const releaseDispatch = createDeferredCore();
    const writerEntered = createDeferredCore();
    const run = costRefreshLane.pool.run.bind(costRefreshLane.pool);
    vi.spyOn(costRefreshLane.pool, "run").mockImplementation(async (input, options) => {
      dispatchReady.resolve();
      await releaseDispatch.promise;
      return run(input, options);
    });
    const admit = writerAdmission.runOpenClawAgentWorkerWrite;
    vi.spyOn(writerAdmission, "runOpenClawAgentWorkerWrite").mockImplementation(
      (options, write, timing, writeSignal, priority) =>
        admit(
          options,
          async () => {
            if (options.path === storePath && priority !== "background") {
              writerEntered.resolve();
            }
            return write();
          },
          timing,
          writeSignal,
          priority,
        ),
    );
    const work = new AsyncWorkScope();
    const refreshing = work.track(() =>
      refreshUsage({ agentId, databasePath: storePath, storePath, env: state.env }),
    );
    const refreshed = Promise.allSettled([refreshing]);
    let writing: Promise<unknown> | undefined;
    let written: Promise<unknown> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(dispatchReady.promise, refreshing, "Usage scan did not dispatch"),
        signal,
      );
      writing = (async () => {
        await using preparation = prepareSessionEntryMutationDatabases(
          [{ scope, assertCurrent() {} }],
          Promise.resolve(),
        );
        const storage = await preparation.preparations[0]!;
        return await createSessionEntryWithTranscript(scope, () => ({ ok: true, entry }), {
          commitGuard: storage.assertCurrent,
        });
      })();
      written = Promise.allSettled([writing]);
      await withinTest(
        awaitGateBeforeSettlement(writerEntered.promise, writing, "Session writer did not enter"),
        signal,
      );
      releaseDispatch.resolve();
      const [refreshResult, writeResult] = await withinTest(
        Promise.all([refreshing, writing]),
        signal,
      );
      expect(refreshResult).toBe("refreshed");
      expect(writeResult).toMatchObject({ ok: true, entry });
      const database = openOpenClawAgentDatabase({ agentId, path: storePath, env: state.env });
      expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry).toMatchObject(entry);
      expect(readRows(agentId, storePath).map((row) => row.key)).not.toContain(
        "removed-session.jsonl",
      );
    } finally {
      work.beginClose();
      releaseDispatch.resolve();
      await Promise.all([refreshed, written]);
      await work.drain();
    }
  });
});

it.each([
  { name: "replacement", write: replaceSessionEntry, retired: false },
  { name: "upsert", write: upsertSessionEntryCore, retired: false },
  { name: "replacement after executor retirement", write: replaceSessionEntry, retired: true },
])(
  "allows the first session $name while a usage refresh is scanning",
  async ({ write, retired }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentId = "main";
      const storePath = retired
        ? openOpenClawAgentDatabase({ agentId, env: state.env }).path
        : state.statePath("fresh-usage-patch.sqlite");
      const scope = { agentId, sessionKey: `agent:${agentId}:first`, storePath, env: state.env };
      const entry = { sessionId: "patched-during-refresh", updatedAt: 1 };
      await using lock = disposableLock(agentId, storePath, { env: state.env });
      if (retired) {
        await closeOpenClawAgentDatabaseByPathAsync(storePath, agentId);
      }
      expect(await lock.acquire()).toBe(true);
      if (!retired) {
        expect(fs.existsSync(storePath)).toBe(false);
      }
      const writeStartedAt = Date.now();
      const written = await write(scope, entry);
      const writeFinishedAt = Date.now();
      assert(written);
      expect(written.sessionId).toBe(entry.sessionId);
      if (write === replaceSessionEntry) {
        expect(written).toEqual({ ...entry, delivery: { kind: "none" } });
      } else {
        expect(written.updatedAt).toBeGreaterThanOrEqual(writeStartedAt);
        expect(written.updatedAt).toBeLessThanOrEqual(writeFinishedAt);
      }
      expect(await lock.writeRollup([rollupRow()])).toBe(true);
      const database = openOpenClawAgentDatabase({ agentId, path: storePath, env: state.env });
      expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry).toEqual(written);
      expect(readRows(agentId, storePath)).toEqual([
        { key: "session.jsonl", valueJson: '{"totalTokens":7}', updatedAt: 1, bodyBytes: 0 },
      ]);
    });
  },
);

it.each(["replacement", "revocation"] as const)(
  "refuses usage acquisition after executor retirement and $0",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentId = "main";
      const database = openOpenClawAgentDatabase({ agentId, env: state.env });
      const storePath = database.path;
      let current = true;
      await using lock = disposableLock(agentId, storePath, {
        env: state.env,
        assertCurrent() {
          if (!current) {
            throw new Error("Refresh revoked");
          }
        },
      });
      await closeOpenClawAgentDatabaseByPathAsync(storePath, agentId);
      if (change === "replacement") {
        const original = state.statePath("original-usage.sqlite");
        fs.renameSync(storePath, original);
        fs.copyFileSync(original, storePath);
      } else {
        current = false;
      }
      const before = fs.readFileSync(storePath);
      await expect(lock.acquire()).rejects.toThrow(
        change === "replacement"
          ? "SQLite database file identity changed before existing-only open"
          : "Refresh revoked",
      );
      expect(fs.readFileSync(storePath)).toEqual(before);
    });
  },
);

it("refuses a missing usage store whose directory alias changes before acquisition", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const original = state.statePath("original");
    const replacement = state.statePath("replacement");
    const alias = state.statePath("alias");
    fs.mkdirSync(original);
    fs.mkdirSync(replacement);
    fs.symlinkSync(original, alias, "junction");
    await using lock = disposableLock("main", path.join(alias, "usage.sqlite"), { env: state.env });
    fs.renameSync(alias, state.statePath("old-alias"));
    fs.symlinkSync(replacement, alias, "junction");
    await expect(lock.acquire()).rejects.toThrow("changed its originally observed target");
    expect(fs.existsSync(path.join(original, "usage.sqlite"))).toBe(false);
    expect(fs.existsSync(path.join(replacement, "usage.sqlite"))).toBe(false);
  });
});

it("allows first session creation while a fresh usage refresh awaits acquisition", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "main";
    const storePath = state.statePath("fresh-usage.sqlite");
    const scope = { agentId, sessionKey: `agent:${agentId}:first`, storePath, env: state.env };
    await using lock = disposableLock(agentId, storePath, { env: state.env });
    await using preparation = prepareSessionEntryMutationDatabases(
      [{ scope, assertCurrent() {} }],
      Promise.resolve(),
    );
    const storage = await preparation.preparations[0]!;
    const created = await createSessionEntryWithTranscript(
      scope,
      () => ({ ok: true, entry: { sessionId: "created-during-refresh", updatedAt: 1 } }),
      { commitGuard: storage.assertCurrent },
    );
    expect(created).toMatchObject({ ok: true, entry: { sessionId: "created-during-refresh" } });
    expect(await lock.acquire()).toBe(true);
    const database = openOpenClawAgentDatabase({ agentId, path: storePath, env: state.env });
    expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry.sessionId).toBe(
      "created-during-refresh",
    );
    await lock.release();
    expect(await isRefreshing(agentId, storePath)).toBe(false);
  });
});

it("rolls back the entire rollup batch when a later row fails", async () => {
  const stateDir = tempDirs.make("openclaw-usage-cache-batch-rollback-");
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const agentId = "worker-1";
    const { db } = openOpenClawAgentDatabase({ agentId });
    await using owner = await acquireUsageLock(agentId);
    await owner.pruneRows([]);
    db.exec(`CREATE TRIGGER refuse_rollup_batch BEFORE INSERT ON cache_entries
      WHEN NEW.key = 'second'
      BEGIN SELECT RAISE(ABORT, 'rollup batch refused'); END;`);
    const rows = ["first", "second"].map((rollupId) => rollupRow(rollupId, "{}"));
    await expect(owner.writeRollup(rows)).rejects.toThrow("rollup batch refused");
    expect(readRows(agentId)).toEqual([]);
    db.exec("DROP TRIGGER refuse_rollup_batch");
    expect(await owner.writeRollup(rows)).toBe(true);
    expect(readRows(agentId).map((row) => row.key)).toEqual(["first", "second"]);
  });
});

it("releases refresh waiters after failed cleanup without retiring their successor", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-cleanup-failure";
    const databasePath = state.statePath("usage.sqlite");
    const failure = new Error("Usage writer cleanup failed");
    const capture = agentExecution.captureOpenClawAgentDatabasePreparationExecution;
    const captured = vi
      .spyOn(agentExecution, "captureOpenClawAgentDatabasePreparationExecution")
      .mockImplementationOnce((...args) => {
        const execution = capture(...args);
        const release = execution.release.bind(execution);
        vi.spyOn(execution, "release").mockImplementationOnce(async () => {
          await release();
          throw failure;
        });
        return execution;
      });
    const owner = prepareLock(agentId, databasePath);
    const successor = prepareLock(agentId, databasePath);
    expect(await owner.acquire()).toBe(true);
    const waiting = successor.acquire(true);
    try {
      await expect(owner.release()).rejects.toBe(failure);
      expect(captured).toHaveBeenCalledTimes(2);
      expect(await waiting).toBe(true);
      const row = rollupRow("fresh-session", '{"totalTokens":2}', 2);
      expect(await successor.writeRollup([row])).toBe(true);
      expect(readRows(agentId, databasePath)).toEqual([
        { key: "fresh-session", valueJson: '{"totalTokens":2}', updatedAt: 2, bodyBytes: 0 },
      ]);
      await owner.release();
      expect(await isRefreshing(agentId, databasePath)).toBe(true);
    } finally {
      await owner.release();
      await waiting;
      await successor.release();
    }
    expect(await isRefreshing(agentId, databasePath)).toBe(false);
  });
});

it("waits for refresh release without persisting lock or status writes", async () => {
  const stateDir = tempDirs.make("openclaw-usage-cache-exclusion-");
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const agentId = "worker-1";
    const database = openOpenClawAgentDatabase({ agentId });
    const owner = prepareLock(agentId, database.path);
    const contender = prepareLock(agentId, database.path);
    const canceled = prepareLock(agentId, database.path);
    const work = new AsyncWorkScope();
    try {
      expect(await isRefreshing(agentId, database.path)).toBe(false);
      expect(await owner.acquire()).toBe(true);
      expect(await contender.acquire()).toBe(false);
      const reason = new Error("Usage detail caller canceled");
      const canceling = work.track(() => canceled.acquire(true));
      work.beginClose(reason);
      await expect(canceling).rejects.toBe(reason);
      expect(await isRefreshing(agentId, database.path)).toBe(true);
      expect(database.db.prepare("SELECT * FROM cache_entries").all()).toEqual([]);
      const waiting = contender.acquire(true);
      await owner.release();
      expect(await waiting).toBe(true);
    } finally {
      work.beginClose();
      await work.drain();
      await canceled.release();
      await owner.release();
      await contender.release();
    }
    expect(await isRefreshing(agentId, database.path)).toBe(false);
    expect(database.db.prepare("SELECT * FROM cache_entries").all()).toEqual([]);
  });
});
