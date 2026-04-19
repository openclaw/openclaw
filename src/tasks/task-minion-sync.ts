import { createSubsystemLogger } from "../logging/subsystem.js";
import type { MinionStore } from "../minions/store.js";
import { taskStatusToMinionStatus } from "./task-status-minion-map.js";
import type { TaskRecord } from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/minion-sync");

let minionStore: MinionStore | null = null;
let storeInitAttempted = false;

async function getStore(): Promise<MinionStore | null> {
  if (minionStore) {
    return minionStore;
  }
  if (storeInitAttempted) {
    return null;
  }
  storeInitAttempted = true;
  try {
    const { MinionStore: Store } = await import("../minions/store.js");
    minionStore = Store.openDefault();
    return minionStore;
  } catch (err) {
    log.debug("Minion store unavailable, shadow-sync disabled", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Shadow-write a TaskRecord into minion_jobs. Uses the taskId as
 * idempotency_key so restarts don't create duplicates (the partial unique
 * index on idempotency_key deduplicates across process lifetimes).
 */
export async function syncTaskToMinions(task: TaskRecord): Promise<void> {
  const store = await getStore();
  if (!store) {
    return;
  }

  try {
    const minionStatus = taskStatusToMinionStatus(task.status);
    const now = Date.now();
    const idempotencyKey = `task:${task.taskId}`;

    const existing = store.db
      .prepare("SELECT id FROM minion_jobs WHERE idempotency_key = ?")
      .get(idempotencyKey) as { id: number | bigint } | undefined;

    if (existing) {
      const existingId = typeof existing.id === "bigint" ? Number(existing.id) : existing.id;
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
          now,
          existingId,
        );
    } else {
      store.db
        .prepare(
          `INSERT INTO minion_jobs (
            name, queue, status, data,
            created_at, updated_at, started_at, finished_at,
            error_text, progress, idempotency_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          idempotencyKey,
        );
    }
  } catch (err) {
    log.debug("Minion shadow-sync failed for task", {
      taskId: task.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function syncTaskDeleteToMinions(taskId: string): Promise<void> {
  const store = await getStore();
  if (!store) {
    return;
  }

  try {
    store.db
      .prepare("DELETE FROM minion_jobs WHERE idempotency_key = ?")
      .run(`task:${taskId}`);
  } catch (err) {
    log.debug("Minion shadow-delete failed for task", {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function resetMinionSyncForTests(): void {
  minionStore = null;
  storeInitAttempted = false;
}
