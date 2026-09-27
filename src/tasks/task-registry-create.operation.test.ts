import { describe, expect, it } from "vitest";
import {
  runTaskCreateOperation,
  type TaskCreateOperations,
} from "./task-registry-create.operation.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

describe("task creation commit boundaries", () => {
  it.each(["metadata", "selection", "authority"] as const)(
    "revalidates %s after publishing a separately committed requester origin",
    (change) => {
      const original: TaskRecord = {
        taskId: "existing-task",
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "existing-run",
        task: "Original request",
        status: "running",
        deliveryStatus: "delivered",
        notifyPolicy: "silent",
        createdAt: 100,
      };
      let current = original;
      let delivery: TaskDeliveryState = { taskId: original.taskId, lastNotifiedEventAt: 150 };
      let retired = false;
      let publications: Array<() => void> = [];
      const committed: string[] = [];
      const taskWrites: TaskRecord[] = [];
      const origin = { channel: "telegram", to: "synthetic-chat" };
      const operations: TaskCreateOperations = {
        readSelection: () => ({ existing: current, deliveryState: delivery }),
        write(operation) {
          publications = [];
          const result = operation();
          for (const publish of publications) {
            publish();
          }
          return result;
        },
        upsertDelivery(state) {
          delivery = state;
        },
        upsertTask(task) {
          taskWrites.push(task);
          current = task;
        },
        deferCommit: (publish) => publications.push(publish),
        onCommitted(commit) {
          committed.push(commit.kind);
          if (commit.kind === "delivery") {
            expect(taskWrites).toEqual([]);
            if (change === "metadata") {
              current = { ...current, progressSummary: "Newly published progress" };
            } else if (change === "selection") {
              current = { ...current, taskId: "replacement-task" };
            } else {
              retired = true;
            }
          }
        },
        assertCurrent() {
          if (retired) {
            throw new Error("Task owner retired");
          }
        },
      };
      const create = () =>
        runTaskCreateOperation(
          {
            taskId: "proposed-task",
            now: 200,
            params: {
              ...original,
              task: "Updated request",
              preferMetadata: true,
              requesterOrigin: origin,
            },
          },
          operations,
        );

      if (change === "metadata") {
        expect(create()).toMatchObject({
          mutation: "updated",
          task: { task: "Updated request", progressSummary: "Newly published progress" },
        });
        expect(taskWrites).toHaveLength(1);
        expect(committed).toEqual(["delivery", "task"]);
      } else {
        expect(create).toThrow(
          change === "selection"
            ? "Task creation selection changed before metadata reuse."
            : "Task owner retired",
        );
        expect(current.task).toBe("Original request");
        expect(taskWrites).toEqual([]);
        expect(committed).toEqual(["delivery"]);
      }
      expect(delivery).toEqual({
        taskId: original.taskId,
        requesterOrigin: origin,
        lastNotifiedEventAt: 150,
      });
    },
  );
});
