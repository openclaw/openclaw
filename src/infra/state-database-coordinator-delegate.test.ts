import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { once } from "node:events";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  acquireStateDatabaseCoordinator,
  attachStateLifecycleDelegate,
  tryCreateStateLifecycleDelegate,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "./state-database-coordinator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withDelegate(
  run: (
    attached: Awaited<ReturnType<typeof attachStateLifecycleDelegate>>,
    delegation: NonNullable<ReturnType<typeof tryCreateStateLifecycleDelegate>>,
    params: { databasePath: string; runtimeDirectory: string; actorId: string },
    coordinatorPath: string,
  ) => Promise<void>,
) {
  const root = tempDirs.make("openclaw-delegated-lifecycle-");
  const params = {
    databasePath: path.join(root, "state", "openclaw.sqlite"),
    runtimeDirectory: path.join(root, "runtime"),
    actorId: "delegated-lifecycle-test",
  };
  await withStateDatabaseCoordinatorRuntimeDirectory(params.runtimeDirectory, async () => {
    const owner = acquireStateDatabaseCoordinator(params);
    const delegation = tryCreateStateLifecycleDelegate(params);
    let attached: Awaited<ReturnType<typeof attachStateLifecycleDelegate>> | undefined;
    try {
      assert(delegation, "Expected a retained lifecycle delegate");
      attached = await attachStateLifecycleDelegate(delegation.port, params);
      await run(attached, delegation, params, owner.path);
    } finally {
      attached?.close();
      delegation?.release();
      owner.release();
    }
  });
}

it("retains async delegation in a custom runtime without admitting a foreign connection", async () => {
  await withDelegate(async (attached, _delegation, params, coordinatorPath) => {
    const lateRead = await attached.run(async () => {
      await Promise.resolve();
      acquireStateDatabaseCoordinator(params).release();
      const worker = new Worker(
        `const { parentPort, workerData } = require('node:worker_threads');
         const { DatabaseSync } = require('node:sqlite');
         const database = new DatabaseSync(workerData);
         try {
           database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
           parentPort.postMessage(true);
         } catch {
           parentPort.postMessage(false);
         } finally { database.close(); }`,
        { eval: true, execArgv: [], workerData: coordinatorPath },
      );
      const exited = once(worker, "exit");
      try {
        expect(await once(worker, "message")).toEqual([false]);
        expect(await exited).toEqual([0]);
      } finally {
        await worker.terminate();
      }
      return AsyncResource.bind(() => acquireStateDatabaseCoordinator(params).release());
    });
    expect(lateRead).toThrow("State lifecycle delegate scope is closed");
  });
});

it("rechecks the retained owner's live authority after an await", async () => {
  await withDelegate(async (attached, delegation, params) => {
    const entered = createDeferred();
    const release = createDeferred();
    const operation = attached.run(async () => {
      entered.resolve();
      await release.promise;
      acquireStateDatabaseCoordinator(params).release();
    });
    try {
      await entered.promise;
      delegation.release();
      release.resolve();
      await expect(operation).rejects.toThrow("State lifecycle delegate is no longer current");
    } finally {
      release.resolve();
      await Promise.allSettled([operation]);
    }
  });
});

it.each(["actor", "path"])("rejects a delegate whose %s does not match", async (mismatch) => {
  await withDelegate(async (_attached, _delegation, params) => {
    const other = tryCreateStateLifecycleDelegate(params);
    assert(other, "Expected a retained lifecycle delegate");
    try {
      await expect(
        attachStateLifecycleDelegate(other.port, {
          ...params,
          ...(mismatch === "actor"
            ? { actorId: "another-request" }
            : { databasePath: path.join(path.dirname(params.databasePath), "other.sqlite") }),
        }),
      ).rejects.toThrow("State lifecycle delegate does not match its actor");
    } finally {
      other.release();
    }
  });
});
