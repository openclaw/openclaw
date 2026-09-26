import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createRuntimeAsyncTasks } from "../plugins/runtime/runtime-tasks-async.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getDetachedTaskLifecycleRuntime } from "./detached-task-runtime.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "./detached-task-runtime.test-support.js";
import { cancelFlowByIdForOwner } from "./task-flow-cancellation.async.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

afterEach(async () => {
  resetDetachedTaskLifecycleRuntimeForTests();
  await closeOpenClawStateDatabaseAsync();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});

it.each(["child completion", "flow replacement", "caller retirement"] as const)(
  "reconciles %s while its original child's cancellation waits",
  async (change) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const ownerKey = "agent:main:cancellation";
      const flows = createRuntimeAsyncTasks().managedFlows.bindSession({ sessionKey: ownerKey });
      const flow = await flows.createManaged({
        controllerId: "tests/cancellation",
        goal: "Synthetic flow",
      });
      const child = await flows.runTask({
        flowId: flow.flowId,
        runtime: "cron",
        runId: "cancellation-child",
        status: "running",
        task: "Synthetic child",
      });
      if (!child.created) {
        throw new Error("Expected linked child task");
      }
      const entered = createDeferred();
      const release = createDeferred();
      let current = true;
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        async cancelDetachedTaskRunById() {
          entered.resolve();
          await release.promise;
          return {
            found: true,
            cancelled: false,
            reason: "Native child outcome is owned separately.",
          };
        },
      });
      const pending = cancelFlowByIdForOwner(
        { cfg: {}, flowId: flow.flowId, callerOwnerKey: ownerKey },
        () => {
          if (!current) {
            throw new Error("Synthetic caller retired");
          }
        },
      );
      try {
        await Promise.race([
          entered.promise,
          pending.then((result) => {
            throw new Error(`Child cancellation was not dispatched: ${JSON.stringify(result)}`);
          }),
        ]);
        await expect(flows.get(flow.flowId)).resolves.toMatchObject({
          cancelRequestedAt: expect.any(Number),
        });
        // Independent committed writers race the retained request, without updating its projection.
        if (change === "child completion") {
          getTaskRegistryStore().upsertTaskWithDeliveryState({
            task: { ...child.task, status: "succeeded", endedAt: Date.now() },
          });
        } else if (change === "flow replacement") {
          getTaskFlowRegistryStore().upsertFlow({
            ...flow,
            createdAt: flow.createdAt + 1,
            controllerId: "tests/replacement",
          });
        } else {
          current = false;
        }
        release.resolve();
        expect(await pending).toMatchObject({ cancelled: change === "child completion" });
        const persisted = await flows.get(flow.flowId);
        if (change === "child completion") {
          expect(persisted).toMatchObject({ status: "cancelled", endedAt: expect.any(Number) });
        } else if (change === "flow replacement") {
          expect(persisted).toMatchObject({
            controllerId: "tests/replacement",
            createdAt: flow.createdAt + 1,
            status: flow.status,
          });
          expect(persisted?.cancelRequestedAt).toBeUndefined();
        } else {
          expect(persisted).toMatchObject({
            status: flow.status,
            cancelRequestedAt: expect.any(Number),
          });
          expect(persisted?.endedAt).toBeUndefined();
        }
      } finally {
        release.resolve();
        await pending;
      }
    });
  },
);
