import { spawn } from "node:child_process";
import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createRuntimeTaskFlow } from "../plugins/runtime/runtime-taskflow.js";
import * as gatewayWorkAdmission from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { captureTaskExecutionOwner } from "../tasks/task-execution-owner.js";
import {
  ensureTaskFlowRegistryReadyAsync,
  listTaskFlowRecords,
  prepareTaskFlowRegistryRead,
  runTaskFlowRegistryWorkerMutation,
} from "../tasks/task-flow-registry.js";
import { normalizeRestoredFlowRecord } from "../tasks/task-flow-registry.records.js";
import { getTaskFlowRegistryStore } from "../tasks/task-flow-registry.store.js";
import {
  loadTaskFlowRegistryStateFromSqliteReadOnly,
  upsertTaskFlowRegistryRecordToSqlite,
} from "../tasks/task-flow-registry.store.sqlite.js";
import { configureTaskFlowRegistryRuntime } from "../tasks/task-flow-registry.store.test-support.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import { retainTaskRegistryRestoreFlowObligations } from "../tasks/task-registry-flow-sync.js";
import { ensureTaskRegistryReadyAsync } from "../tasks/task-registry-state.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
} from "../tasks/task-registry.store.js";
import { upsertTaskWithDeliveryStateToSqlite } from "../tasks/task-registry.store.sqlite.js";
import type { TaskExecutionOwner, TaskRecord } from "../tasks/task-registry.types.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../test-utils/task-registry-store.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { interceptTaskWorkerCommands } from "./sqlite-worker-task.test-support.js";

let executionOwner: TaskExecutionOwner;

beforeAll(async () => {
  executionOwner = await exitedExecutionOwner();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function exitedExecutionOwner() {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    env: { PATH: process.env.PATH },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const exited = once(child, "exit");
  try {
    await once(child, "spawn");
    const owner = expectDefined(captureTaskExecutionOwner(child.pid), "owned fixture process");
    child.stdin.end();
    await exited;
    return owner;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
  }
}

function holdRestoreReply(target: "tasks.restore" | "flows.syncMirroredTask") {
  const held = createDeferred();
  const release = createDeferred();
  let failure: Error | undefined;
  interceptTaskWorkerCommands(async (type, execute) => {
    const result = await execute();
    if (type === target) {
      held.resolve();
      await release.promise;
      if (failure) {
        throw failure;
      }
    }
    return result;
  });
  return {
    held,
    release,
    fail: (error: Error) => {
      failure = error;
    },
  };
}

it.each([
  { operation: "restore", unrelatedPending: false, completion: "normal" },
  { operation: "restore", unrelatedPending: true, completion: "normal" },
  { operation: "restored retry", unrelatedPending: false, completion: "normal" },
  { operation: "restored retry", unrelatedPending: true, completion: "normal" },
  { operation: "restore", unrelatedPending: false, completion: "lost reply" },
  { operation: "restore", unrelatedPending: false, completion: "replaced owner" },
  { operation: "restore", unrelatedPending: false, completion: "refused admission" },
] as const)(
  "keeps committed $operation flow reads current with unrelated pending work=$unrelatedPending and $completion",
  async ({ operation, unrelatedPending, completion }) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      const ownerKey = "agent:main:restore-admission";
      const flow: TaskFlowRecord = {
        flowId: "restored-parent",
        syncMode: "task_mirrored",
        ownerKey,
        revision: 0,
        status: "running",
        notifyPolicy: "silent",
        goal: "Before restoration",
        stateJson: { cursor: [1, 2, 3] },
        createdAt: 10,
        updatedAt: 10,
      };
      const task: TaskRecord = {
        taskId: "orphaned-task",
        runtime: "cli",
        ownerKey,
        requesterSessionKey: ownerKey,
        scopeKind: "session",
        task: "Restored canonical task",
        status: operation === "restore" ? "running" : "succeeded",
        ...(operation === "restored retry" ? { endedAt: 20 } : {}),
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        parentFlowId: flow.flowId,
        executionOwner,
        createdAt: 10,
      };
      upsertTaskFlowRegistryRecordToSqlite(flow);
      upsertTaskWithDeliveryStateToSqlite({ task });
      const context = captureOpenClawStateWorkerContext();
      await ensureTaskFlowRegistryReadyAsync(context);
      const detachedWork: Promise<unknown>[] = [];
      const runDetached = gatewayWorkAdmission.runWithGatewayDetachedWorkContinuation;
      vi.spyOn(gatewayWorkAdmission, "runWithGatewayDetachedWorkContinuation").mockImplementation(
        <T>(run: () => Promise<T>, origin?: string) => {
          const work = runDetached(run, origin);
          detachedWork.push(work);
          return work;
        },
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const legacy = createRuntimeTaskFlow().bindSession({ sessionKey: ownerKey });
      const unrelatedRelease = createDeferred();
      const flowStore = getTaskFlowRegistryStore();
      const unrelated = unrelatedPending
        ? runTaskFlowRegistryWorkerMutation(
            { flowId: "unrelated-flow", admission: context.admission },
            () => unrelatedRelease.promise,
            () => flowStore.readFlowAsync(context, "unrelated-flow"),
          )
        : undefined;
      const { held, release, fail } = holdRestoreReply(
        operation === "restore" ? "tasks.restore" : "flows.syncMirroredTask",
      );
      const refused = createDeferred();
      if (completion === "refused admission") {
        const original = workerAdmission.createSqliteWorkerOperationAdmission;
        vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
          (admit) =>
            original((request, grant) => {
              if (isRecord(request.facts) && request.facts.kind === "task-restored-flow") {
                configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
                refused.resolve();
              }
              admit(request, grant);
            }),
        );
      }
      let pending: Promise<void> | undefined;
      try {
        if (operation === "restore") {
          pending = ensureTaskRegistryReadyAsync(context);
        } else {
          retainTaskRegistryRestoreFlowObligations(context, getTaskRegistryStore(), [task]);
          await vi.advanceTimersByTimeAsync(1_000);
        }
        await (completion === "refused admission" ? refused.promise : held.promise);
        const canonical = normalizeRestoredFlowRecord(
          expectDefined(
            loadTaskFlowRegistryStateFromSqliteReadOnly().flows.get(flow.flowId),
            "committed worker flow",
          ),
        );
        expect(canonical).toMatchObject(
          completion === "refused admission"
            ? flow
            : {
                goal: task.task,
                status: operation === "restore" ? "cancelled" : "succeeded",
                revision: 1,
              },
        );
        if (completion === "normal") {
          expect.soft(legacy.get(flow.flowId)).toEqual(canonical);
          expect.soft(listTaskFlowRecords()).toEqual([canonical]);
          expect.soft(legacy.list()).toEqual([canonical]);
        } else if (completion === "lost reply") {
          fail(new SqliteWorkerError("Synthetic lost restore result", "outcome-unknown"));
        } else if (completion === "replaced owner") {
          configureTaskFlowRegistryRuntime({
            store: createInMemoryTaskFlowRegistryStore({
              flows: new Map([[flow.flowId, { ...flow, revision: 40, goal: "Replacement owner" }]]),
            }),
          });
        }
      } finally {
        release.resolve();
        unrelatedRelease.resolve();
        const results = await Promise.allSettled([pending, unrelated]);
        try {
          await Promise.allSettled(detachedWork);
          expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(0);
          if (completion !== "normal") {
            expect(results[0]?.status).toBe(
              completion === "refused admission" ? "fulfilled" : "rejected",
            );
            const expected =
              completion === "refused admission"
                ? flow
                : completion === "lost reply"
                  ? { revision: 1, goal: task.task, status: "cancelled" }
                  : { revision: 40, goal: "Replacement owner" };
            expect(legacy.get(flow.flowId)).toMatchObject(expected);
            const read = await prepareTaskFlowRegistryRead();
            expect(read?.getTaskFlowById(flow.flowId)).toMatchObject(expected);
          }
        } finally {
          vi.useRealTimers();
          await closeOpenClawStateDatabaseAsync();
          resetTaskRegistryForTests({ persist: false });
          resetTaskFlowRegistryForTests({ persist: false });
        }
      }
    });
  },
);
