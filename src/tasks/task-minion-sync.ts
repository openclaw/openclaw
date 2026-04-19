import { createSubsystemLogger } from "../logging/subsystem.js";
import type { MinionStore } from "../minions/store.js";
import type { MinionJobRow } from "../minions/types.js";
import { taskStatusToMinionStatus } from "./task-status-minion-map.js";
import type { TaskRecord } from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/minion-sync");

let minionStore: MinionStore | null = null;
let storeInitAttempted = false;
const taskToMinionId = new Map<string, number>();

function getStore(): MinionStore | null {
  if (minionStore) {
    return minionStore;
  }
  if (storeInitAttempted) {
    return null;
  }
  storeInitAttempted = true;
  try {
    const { MinionStore: Store } = require("../minions/store.js") as typeof import("../minions/store.js");
    minionStore = Store.openDefault();
    return minionStore;
  } catch (err) {
    log.debug("Minion store unavailable, shadow-sync disabled", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function syncTaskToMinions(task: TaskRecord): void {
  const store = getStore();
  if (!store) {
    return;
  }

  try {
    const minionStatus = taskStatusToMinionStatus(task.status);
    const existingId = taskToMinionId.get(task.taskId);

    if (existingId != null) {
      store.db
        .prepare(
          `UPDATE minion_jobs SET
            status = ?, error_text = ?, progress = ?,
            started_at = ?, finished_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          minionStatus,
          task.error ?? null,
          task.progressSummary ?? null,
          task.startedAt ?? null,
          task.endedAt ?? null,
          Date.now(),
          existingId,
        );
    } else {
      const now = Date.now();
      const result = store.db
        .prepare(
          `INSERT INTO minion_jobs (
            name, queue, status, data,
            created_at, updated_at, started_at, finished_at,
            error_text, progress
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `task.${task.runtime}`,
          "default",
          minionStatus,
          JSON.stringify({
            taskId: task.taskId,
            runtime: task.runtime,
            taskKind: task.taskKind,
            ownerKey: task.ownerKey,
            childSessionKey: task.childSessionKey,
            runId: task.runId,
            label: task.label,
            task: task.task,
          }),
          task.createdAt,
          now,
          task.startedAt ?? null,
          task.endedAt ?? null,
          task.error ?? null,
          task.progressSummary ?? null,
        );
      const insertedId =
        typeof result.lastInsertRowid === "bigint"
          ? Number(result.lastInsertRowid)
          : result.lastInsertRowid;
      taskToMinionId.set(task.taskId, insertedId);
    }
  } catch (err) {
    log.debug("Minion shadow-sync failed for task", {
      taskId: task.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function syncTaskDeleteToMinions(taskId: string): void {
  const store = getStore();
  if (!store) {
    return;
  }

  try {
    const minionId = taskToMinionId.get(taskId);
    if (minionId != null) {
      store.db.prepare("DELETE FROM minion_jobs WHERE id = ?").run(minionId);
      taskToMinionId.delete(taskId);
    }
  } catch (err) {
    log.debug("Minion shadow-delete failed for task", {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function resetMinionSyncForTests(): void {
  taskToMinionId.clear();
  minionStore = null;
  storeInitAttempted = false;
}
