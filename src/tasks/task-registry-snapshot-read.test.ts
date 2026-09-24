import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as workerStore from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import { upsertTaskWithDeliveryStateInDatabase } from "./task-registry.store.kernel.js";
import type { TaskRecord } from "./task-registry.types.js";

const tempDirs = useStateDatabaseTempDirs();

function fixture() {
  const root = tempDirs.make("task-snapshot-reader-");
  const options = { path: path.join(root, "state.sqlite"), env: { OPENCLAW_STATE_DIR: root } };
  const database = openOpenClawStateDatabase(options);
  const tasks = ["direct", "related", "unrelated"].map((taskId, index): TaskRecord => ({
    taskId,
    runtime: "cli",
    requesterSessionKey: "agent:main:fixture",
    ownerKey: "agent:main:fixture",
    scopeKind: "session",
    task: `Synthetic ${taskId}`,
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "silent",
    createdAt: index + 1,
    runId: taskId === "unrelated" ? "other-run" : "shared-run",
  }));
  for (const task of tasks) {
    upsertTaskWithDeliveryStateInDatabase(database, {
      task,
      deliveryState: { taskId: task.taskId, lastNotifiedEventAt: task.createdAt },
    });
  }
  return { options, tasks };
}

it("reads full and scoped task snapshots without host SQL or writable broker admission", async () => {
  const { options, tasks } = fixture();
  await closeOpenClawStateDatabaseAsync();
  const context = captureOpenClawStateWorkerContext(options);
  const broker = vi.spyOn(workerStore, "executeOpenClawStateWorker").mockImplementation(() => {
    throw new Error("A task snapshot entered writable broker admission");
  });
  requireNodeSqlite();
  const sql = observeMainThreadSql();
  const store = getTaskRegistryStore();
  for (const [scope, expected] of [
    [undefined, tasks],
    [{ taskId: "direct", runId: "shared-run" }, tasks.slice(0, 2)],
    [[{ taskId: "direct" }, { taskId: "related" }], tasks.slice(0, 2)],
    [[], []],
  ] as const) {
    const snapshot = await store.loadMutationSnapshotAsync(context, scope);
    expect([...snapshot.tasks.values()]).toEqual(expected);
    expect([...snapshot.deliveryStates.values()]).toEqual(
      expected.map((task) => ({ taskId: task.taskId, lastNotifiedEventAt: task.createdAt })),
    );
  }
  expect(broker).not.toHaveBeenCalled();
  sql.expectIdle();
});

it("rejects a retired task read admission after the same database reopens", async () => {
  const { options } = fixture();
  const context = captureOpenClawStateWorkerContext(options);
  await closeOpenClawStateDatabaseAsync();
  openOpenClawStateDatabase(options);
  await expect(getTaskRegistryStore().loadMutationSnapshotAsync(context)).rejects.toThrow(
    /admission|closed|generation|invalidated/i,
  );
});

it("does not create missing task state or report an empty snapshot", async () => {
  const root = tempDirs.make("task-snapshot-missing-");
  const pathname = path.join(root, "state.sqlite");
  const context = captureOpenClawStateWorkerContext({
    path: pathname,
    env: { OPENCLAW_STATE_DIR: root },
  });
  await expect(getTaskRegistryStore().loadMutationSnapshotAsync(context)).rejects.toThrow(
    "Task registry snapshot requires an admitted database",
  );
  expect(fs.existsSync(pathname)).toBe(false);
});
