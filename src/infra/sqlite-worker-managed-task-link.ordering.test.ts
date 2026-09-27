import "./sqlite-worker-managed-task-link.test-support.js";
import { describe, expect, it } from "vitest";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { captureTaskRegistryReadFence } from "../tasks/task-registry-listener-state.js";
import { getTaskById, listTasksForFlowId } from "../tasks/task-registry.js";
import { onTaskRegistryChange } from "../tasks/task-registry.store.js";
import { emitAgentEvent } from "./agent-events.js";

const {
  ownerKey,
  childSessionKey,
  runId,
  createBacking,
  holdTaskCreationCommand,
  holdTaskEventPublication,
} = await import("./sqlite-worker-managed-task-link.test-support.js");

describe("registered async managed child linkage", () => {
  it("keeps deferred observer order through a reentrant native successor", async () => {
    const backing = createBacking();
    const successor = createBacking({
      runId: "reentrant-successor",
      childSessionKey: "agent:main:reentrant-successor",
    });
    const managed = createPluginRuntime().tasks.async.managedFlows.bindSession({
      sessionKey: ownerKey,
    });
    const flow = await managed.createManaged({
      controllerId: "tests/reentrant",
      goal: "Observer order",
    });
    const held = holdTaskCreationCommand("flows.runTask", "after commit");
    const backingPublication = holdTaskEventPublication(backing.taskId);
    const observed: string[] = [];
    const successorObserved = createDeferredCore();
    let linkedTaskId: string | undefined;
    let successorStatus: string | undefined;
    let reentered = false;
    const stopReentry = onTaskRegistryChange((event) => {
      if (
        event?.kind !== "upserted" ||
        event.task.taskId !== linkedTaskId ||
        event.task.status !== "succeeded" ||
        reentered
      ) {
        return;
      }
      reentered = true;
      emitAgentEvent({
        runId: successor.runId!,
        stream: "lifecycle",
        data: { phase: "end", endedAt: 300 },
      });
      successorStatus = getTaskById(successor.taskId)?.status;
    });
    const stopObserver = onTaskRegistryChange((event) => {
      if (event?.kind === "upserted" && event.task.status === "succeeded") {
        observed.push(event.task.taskId);
        if (event.task.taskId === successor.taskId) {
          successorObserved.resolve();
        }
      }
    });
    const pending = managed.runTask({
      flowId: flow.flowId,
      runtime: "acp",
      runId,
      childSessionKey,
      task: "Child work",
      status: "running",
      startedAt: 100,
      notifyPolicy: "silent",
    });
    try {
      await held.ready;
      emitAgentEvent({
        runId,
        sessionKey: childSessionKey,
        stream: "lifecycle",
        data: { phase: "end", endedAt: 200 },
      });
      await backingPublication.ready;
      held.release();
      const receipt = await pending;
      expect(receipt.created).toBe(true);
      if (!receipt.created) {
        throw new Error(receipt.reason);
      }
      linkedTaskId = receipt.task.taskId;
      expect(listTasksForFlowId(flow.flowId)).toMatchObject([{ status: "succeeded" }]);
      backingPublication.release();
      await successorObserved.promise;
      await captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission);
      expect(successorStatus).toBe("succeeded");
      expect(observed).toEqual([backing.taskId, linkedTaskId, successor.taskId]);
    } finally {
      stopReentry();
      stopObserver();
      backingPublication.release();
      held.release();
      await pending;
    }
  });
});
