import { describe, expect, it } from "vitest";
import { createRunningTaskRunCore } from "../../tasks/task-executor.js";
import { getTaskById } from "../../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../../tasks/task-registry.store.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createInMemoryTaskRegistryStore } from "../../test-utils/task-registry-store.js";
import {
  completeDurableDelivery,
  createCommandCronDeliveryCustody,
  failDurableDelivery,
  markDurableDeliveryQueued,
  rejectDurableDelivery,
} from "./delivery-completion.js";

describe("command cron durable delivery completion", () => {
  const resetWithMemoryStore = () => {
    resetTaskRegistryForTests({ persist: false });
    const store = createInMemoryTaskRegistryStore();
    configureTaskRegistryRuntime({ store });
    return store;
  };

  it("settles only the exact task and persists no recipient data", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-command-delivery-completion-" },
      async () => {
        resetWithMemoryStore();
        const runId = "cron:job-a:1000:receipt-a";
        const task = createRunningTaskRunCore({
          runtime: "cron",
          sourceId: "job-a",
          ownerKey: "",
          scopeKind: "system",
          agentId: "main",
          runId,
          task: "command job",
          deliveryStatus: "pending",
          notifyPolicy: "silent",
          startedAt: 1_000,
          detail: { storeKey: "cron-store" },
        });
        const adjacent = createRunningTaskRunCore({
          runtime: "cron",
          sourceId: "job-a",
          ownerKey: "",
          scopeKind: "system",
          agentId: "main",
          runId: "cron:job-a:1000:receipt-b",
          task: "adjacent command job",
          deliveryStatus: "pending",
          notifyPolicy: "silent",
          startedAt: 1_000,
          detail: { storeKey: "cron-store" },
        });
        expect(task).not.toBeNull();
        expect(adjacent).not.toBeNull();
        const custody = createCommandCronDeliveryCustody({ taskId: task!.taskId, runId });
        const recoveredCompletion = structuredClone(custody.deliveryCompletion);

        await expect(
          markDurableDeliveryQueued(recoveredCompletion, custody.deliveryIntentId),
        ).resolves.toEqual({ state: "queued" });
        await expect(
          completeDurableDelivery(recoveredCompletion, {
            channel: "matrix",
            messageId: "provider-message-id",
            target: { kind: "room", id: "private-room" },
          }),
        ).resolves.toEqual({ state: "delivered" });

        expect(getTaskById(task!.taskId)).toMatchObject({
          deliveryStatus: "delivered",
          detail: {
            deliveryEvidence: { intentId: custody.deliveryIntentId, state: "delivered" },
          },
        });
        expect(getTaskById(adjacent!.taskId)?.deliveryStatus).toBe("pending");
        const persisted = JSON.stringify(getTaskById(task!.taskId)?.detail);
        expect(persisted).not.toContain("provider-message-id");
        expect(persisted).not.toContain("private-room");
        resetTaskRegistryForTests({ persist: false });
      },
    );
  });

  it("keeps rejection and ambiguous send outcomes distinct", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-command-delivery-states-" },
      async () => {
        resetWithMemoryStore();
        const create = (suffix: string) => {
          const runId = `cron:job:${suffix}`;
          const task = createRunningTaskRunCore({
            runtime: "cron",
            sourceId: "job",
            ownerKey: "",
            scopeKind: "system",
            agentId: "main",
            runId,
            task: suffix,
            deliveryStatus: "pending",
            notifyPolicy: "silent",
            startedAt: 1_000,
            detail: { storeKey: "cron-store" },
          })!;
          return {
            task,
            custody: createCommandCronDeliveryCustody({ taskId: task.taskId, runId }),
          };
        };
        const rejected = create("rejected");
        const unknown = create("unknown");

        await rejectDurableDelivery(rejected.custody.deliveryCompletion, "private provider error");
        await failDurableDelivery(unknown.custody.deliveryCompletion);

        expect(getTaskById(rejected.task.taskId)?.detail).toMatchObject({
          deliveryEvidence: { state: "rejected" },
        });
        expect(getTaskById(unknown.task.taskId)?.detail).toMatchObject({
          deliveryEvidence: { state: "unknown" },
        });
        expect(JSON.stringify(getTaskById(rejected.task.taskId)?.detail)).not.toContain(
          "private provider error",
        );
        resetTaskRegistryForTests({ persist: false });
      },
    );
  });

  it("rejects mismatched durable custody instead of guessing", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-command-delivery-stale-" },
      async () => {
        resetWithMemoryStore();
        const task = createRunningTaskRunCore({
          runtime: "cron",
          sourceId: "job",
          ownerKey: "",
          scopeKind: "system",
          agentId: "main",
          runId: "real-run",
          task: "command job",
          deliveryStatus: "pending",
          notifyPolicy: "silent",
          startedAt: 1_000,
        })!;
        const custody = createCommandCronDeliveryCustody({
          taskId: task.taskId,
          runId: "forged-run",
        });

        await expect(
          markDurableDeliveryQueued(custody.deliveryCompletion, custody.deliveryIntentId),
        ).resolves.toEqual({ state: "stale" });
        expect(getTaskById(task.taskId)?.deliveryStatus).toBe("pending");
        resetTaskRegistryForTests({ persist: false });
      },
    );
  });

  it("preserves a committed terminal outcome when recovery observes the queue again", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-command-delivery-terminal-" },
      async () => {
        resetWithMemoryStore();
        const runId = "cron:job:terminal";
        const task = createRunningTaskRunCore({
          runtime: "cron",
          sourceId: "job",
          ownerKey: "",
          scopeKind: "system",
          agentId: "main",
          runId,
          task: "terminal evidence",
          deliveryStatus: "pending",
          notifyPolicy: "silent",
          startedAt: 1_000,
        })!;
        const custody = createCommandCronDeliveryCustody({ taskId: task.taskId, runId });

        await completeDurableDelivery(custody.deliveryCompletion, {
          channel: "matrix",
          messageId: "synthetic-message",
        });
        await expect(
          markDurableDeliveryQueued(custody.deliveryCompletion, custody.deliveryIntentId),
        ).resolves.toEqual({ state: "delivered" });
        expect(getTaskById(task.taskId)).toMatchObject({
          deliveryStatus: "delivered",
          detail: { deliveryEvidence: { state: "delivered" } },
        });
        resetTaskRegistryForTests({ persist: false });
      },
    );
  });

  it("surfaces task storage failure instead of retiring queue custody as stale", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-command-delivery-storage-failure-" },
      async () => {
        const store = resetWithMemoryStore();
        const runId = "cron:job:storage-failure";
        const task = createRunningTaskRunCore({
          runtime: "cron",
          sourceId: "job",
          ownerKey: "",
          scopeKind: "system",
          agentId: "main",
          runId,
          task: "storage failure",
          deliveryStatus: "pending",
          notifyPolicy: "silent",
          startedAt: 1_000,
        })!;
        store.runInitialMutationAsync = async () => {
          throw new Error("synthetic task storage failure");
        };
        const custody = createCommandCronDeliveryCustody({ taskId: task.taskId, runId });

        await expect(
          markDurableDeliveryQueued(custody.deliveryCompletion, custody.deliveryIntentId),
        ).rejects.toThrow("synthetic task storage failure");
        expect(getTaskById(task.taskId)?.detail).not.toMatchObject({
          deliveryEvidence: { state: "queued" },
        });
        resetTaskRegistryForTests({ persist: false });
      },
    );
  });
});
