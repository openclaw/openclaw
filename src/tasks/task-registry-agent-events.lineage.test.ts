import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import { tasks } from "./task-registry-state.js";
import { getTaskById } from "./task-registry.js";
import { getTaskRegistryStore, onTaskRegistryChange } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  resetGatewayWorkAdmission();
  resetSystemEventsForTest();
});

async function joinEvents() {
  await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
}

function emitTool(runId: string, name: string) {
  emitAgentEvent({ runId, stream: "tool", data: { phase: "start", name } });
}

describe("task agent event lineage", () => {
  it.each([
    "after publication",
    "during readback",
    "during readback without terminal",
    "after settled replacement",
    "after settled replacement before result",
    "after replacement before first settlement",
    "after replacement before first result",
  ] as const)(
    "retains normalized start lineage and accepted terminal fences %s",
    async (scenario) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const task = createTaskFixture("cli", {
          runId: "normalized-publication",
          task: "Preserve the accepted terminal",
          status: "queued",
          startedAt: 1_000,
          notifyPolicy: "silent",
          deliveryStatus: "not_applicable",
        });
        const replaced = scenario.includes("replacement");
        const terminalQueued = !replaced && scenario !== "during readback without terminal";
        const started = createDeferred();
        let replacementCommitted = false;
        let emitted = false;
        const emitAfterStart = (current: ReturnType<typeof getTaskById>) => {
          if (!emitted && current?.startedAt === (replaced ? 1_000 : 0)) {
            emitted = true;
            emitTool(task.runId!, "successor");
            started.resolve();
          }
        };
        const stop = onTaskRegistryChange(() => {
          if (scenario === "after publication") {
            emitAfterStart(tasks.get(task.taskId));
          }
        });
        if (scenario !== "after publication") {
          const store = getTaskRegistryStore();
          if (replaced) {
            const mutate = store.runAgentEventMutationAsync.bind(store);
            vi.spyOn(store, "runAgentEventMutationAsync").mockImplementationOnce(
              async (...args) => {
                const receipt = await mutate(...args);
                if (scenario.startsWith("after settled")) {
                  expect(getTaskById(task.taskId)?.startedAt).toBe(0);
                }
                for (const record of [{ ...task, task: "Intervening replacement" }, task]) {
                  store.upsertTaskWithDeliveryState({ task: record });
                  publishTaskRecordAfterAtomicStore(record);
                }
                replacementCommitted = true;
                if (scenario.endsWith("result")) {
                  emitAfterStart(tasks.get(task.taskId));
                }
                return receipt;
              },
            );
          }
          const read = store.loadMutationSnapshotAsync.bind(store);
          vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
            const snapshot = await read(...args);
            if (
              !emitted &&
              (!replaced || replacementCommitted) &&
              snapshot.tasks.get(task.taskId)?.startedAt === (replaced ? 1_000 : 0)
            ) {
              expect(tasks.get(task.taskId)?.startedAt).toBe(1_000);
              emitAfterStart(snapshot.tasks.get(task.taskId));
            }
            return snapshot;
          });
        }
        try {
          emitAgentEvent({
            runId: task.runId!,
            stream: "lifecycle",
            data: { phase: "start", startedAt: 0 },
          });
          if (terminalQueued) {
            emitAgentEvent({
              runId: task.runId!,
              stream: "lifecycle",
              data: { phase: "end", endedAt: 2_000 },
            });
          }
          await started.promise;
          await joinEvents();
          const current = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
          expect(current).toMatchObject({
            status: terminalQueued ? "succeeded" : replaced ? "queued" : "running",
            startedAt: replaced ? 1_000 : 0,
          });
          expect(current?.endedAt).toBe(terminalQueued ? 2_000 : undefined);
          expect(current?.toolUseCount ?? 0).toBe(terminalQueued ? 0 : 1);
          expect(current?.lastToolName).toBe(terminalQueued ? undefined : "successor");
        } finally {
          stop();
        }
      });
    },
  );
});
