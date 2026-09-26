// SQLite task and delivery writes publish only after their transaction commits.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { applyTaskRegistryMaintenanceRetention } from "./task-registry-maintenance-retention.js";
import { taskRegistryLog } from "./task-registry-state.js";
import {
  createTaskRecord as createTaskRecordOrNull,
  findTaskByRunId,
  listFreshTasksForOwnerKey,
  listTaskRecords,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
import { configureTaskRegistryMaintenance } from "./task-registry.maintenance.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import {
  loadTaskRegistryStateFromSqlite,
  loadTaskRegistryStateFromSqliteReadOnly,
} from "./task-registry.store.sqlite.js";
import type { TaskRegistryObserverEvent } from "./task-registry.store.types.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

function createTaskRecord(params: Parameters<typeof createTaskRecordOrNull>[0]): TaskRecord {
  const task = createTaskRecordOrNull(params);
  if (!task) {
    throw new Error("expected task creation to succeed");
  }
  return task;
}

describe("task-registry store atomicity", () => {
  afterEach(() => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    configureTaskRegistryMaintenance({ runtimeAuthoritative: false });
    loggingState.rawConsole = null;
    setLoggerOverride(null);
    resetLogger();
  });

  it.each(["create", "update", "delete"] as const)(
    "keeps SQLite and published task state atomic when %s persistence fails",
    async (operation) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: `openclaw-task-atomic-${operation}-` },
        async () => {
          resetTaskRegistryForTests({ persist: false });
          const params = {
            runtime: "cli" as const,
            ownerKey: "agent:main:main",
            scopeKind: "session" as const,
            runId: `atomic-${operation}`,
            task: "Preserve task and delivery state together",
            status: operation === "delete" ? ("succeeded" as const) : ("running" as const),
            ...(operation === "delete" ? { cleanupAfter: 0 } : {}),
            deliveryStatus: "pending" as const,
            notifyPolicy: "silent" as const,
            requesterOrigin: { channel: "test-channel", to: "C1234567890" },
          };
          const existing = operation === "create" ? undefined : createTaskRecord(params);
          const visibleBefore = listTaskRecords();
          const storedBefore = loadTaskRegistryStateFromSqlite();
          const observed: Array<{
            kind: TaskRegistryObserverEvent["kind"];
            stored: ReturnType<typeof loadTaskRegistryStateFromSqlite>;
            visible: TaskRecord[];
          }> = [];
          configureTaskRegistryRuntime({
            observers: {
              onEvent: (event) => {
                observed.push({
                  kind: event.kind,
                  stored: loadTaskRegistryStateFromSqliteReadOnly(),
                  visible: listTaskRecords(),
                });
              },
            },
          });
          const mutate = async () => {
            if (operation === "create") {
              return createTaskRecordOrNull(params);
            }
            if (!existing) {
              throw new Error("expected the existing task fixture");
            }
            return operation === "update"
              ? updateTaskNotifyPolicyById({
                  taskId: existing.taskId,
                  notifyPolicy: "state_changes",
                })
              : applyTaskRegistryMaintenanceRetention(existing, Date.now(), new Map(), () => {});
          };
          const { db } = openOpenClawStateDatabase();
          const failingStatement =
            operation === "delete" ? "DELETE ON task_runs" : "INSERT ON task_delivery_state";
          if (operation === "delete") {
            // Complete schema admission so the injected fault reaches the worker's DELETE.
            await listFreshTasksForOwnerKey(params.ownerKey);
          }
          // Fail the second statement: a missing transaction would leave the first row change behind.
          db.exec(`
            CREATE ${operation === "delete" ? "" : "TEMP "}TRIGGER reject_task_write BEFORE ${failingStatement}
            BEGIN SELECT RAISE(ABORT, 'synthetic task write failure'); END;
          `);
          const retentionWarning =
            operation === "delete" ? vi.spyOn(taskRegistryLog, "warn") : undefined;
          try {
            expect(await mutate()).toBe(operation === "delete" ? undefined : null);
            if (retentionWarning) {
              expect(retentionWarning).toHaveBeenCalledWith(
                "Failed to apply task retention",
                expect.objectContaining({
                  error: expect.objectContaining({ message: "synthetic task write failure" }),
                }),
              );
            }
            expect(loadTaskRegistryStateFromSqlite()).toEqual(storedBefore);
            expect(listTaskRecords()).toEqual(visibleBefore);
            expect(findTaskByRunId(params.runId)).toEqual(existing);
            expect(observed).toEqual([]);
          } finally {
            retentionWarning?.mockRestore();
            db.exec("DROP TRIGGER reject_task_write");
          }

          const result = await mutate();
          expect(result).not.toBeNull();
          expect(result).not.toBe(false);
          const storedAfter = loadTaskRegistryStateFromSqlite();
          if (operation === "delete") {
            expect(result).toBe("pruned");
            expect(storedAfter.tasks.size).toBe(0);
            expect(storedAfter.deliveryStates.size).toBe(0);
            expect(findTaskByRunId(params.runId)).toBeUndefined();
          } else {
            const current = findTaskByRunId(params.runId);
            expect(current).toMatchObject({
              notifyPolicy: operation === "update" ? "state_changes" : "silent",
            });
            expect(storedAfter.tasks.get(current?.taskId ?? "")).toMatchObject({
              task: params.task,
              notifyPolicy: operation === "update" ? "state_changes" : "silent",
            });
            expect(storedAfter.deliveryStates.get(current?.taskId ?? "")?.requesterOrigin).toEqual(
              params.requesterOrigin,
            );
          }
          expect(observed.map((event) => event.kind)).toEqual([
            operation === "delete" ? "deleted" : "upserted",
          ]);
          expect(observed[0]?.stored).toEqual(storedAfter);
          expect(observed[0]?.visible).toEqual(listTaskRecords());
        },
      );
    },
  );
});
