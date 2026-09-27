import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../test-utils/task-registry-store.js";
import { getTaskFlowRegistryRestoreFailure, listTaskFlowRecords } from "./task-flow-registry.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { runTaskDeliveryWithDetachedAdmission } from "./task-registry-delivery-admission.js";
import {
  isRegistryRestoreRetryDue,
  resolveRegistryRestoreRetryAtMs,
} from "./task-registry-restore.js";
import { assertTaskRegistryRestoreNotFailed } from "./task-registry-state.js";
import { getTaskById } from "./task-registry.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import { createStoredTask } from "./task-registry.test-support.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

const RETRY_MS = 30_000;

function sqliteError(message: string, errcode: number): Error {
  return Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR", errcode });
}

function failingTaskStore(firstError: Error, task: TaskRecord) {
  let fail = true;
  const loadSnapshot = vi.fn(() => {
    if (fail) {
      throw firstError;
    }
    return {
      tasks: new Map([[task.taskId, task]]),
      deliveryStates: new Map<string, TaskDeliveryState>(),
    };
  });
  configureTaskRegistryRuntime({
    store: { ...createInMemoryTaskRegistryStore(), loadSnapshot },
  });
  return {
    loadSnapshot,
    recover: () => {
      fail = false;
    },
  };
}

describe("registry restore retry after transient SQLite failures", () => {
  let testState: OpenClawTestState;
  let nowMs = 1_000_000;

  beforeAll(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-task-transient-restore-",
    });
  });

  afterAll(async () => {
    await testState.cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetGatewayWorkAdmission();
    testState.applyEnv();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  function freezeClock() {
    nowMs = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  }

  it("schedules a retry only for transient storage failures", () => {
    expect(resolveRegistryRestoreRetryAtMs(sqliteError("disk I/O error", 266), 100)).toBe(
      100 + RETRY_MS,
    );
    expect(resolveRegistryRestoreRetryAtMs(sqliteError("x", 5), 100)).toBe(100 + RETRY_MS);
    expect(
      resolveRegistryRestoreRetryAtMs(
        new Error("wrapped", { cause: new Error("database is locked") }),
        100,
      ),
    ).toBe(100 + RETRY_MS);
    expect(
      resolveRegistryRestoreRetryAtMs(sqliteError("database disk image is malformed", 11), 100),
    ).toBeUndefined();
    expect(
      resolveRegistryRestoreRetryAtMs(new Error("Invalid persisted task delivery status"), 100),
    ).toBeUndefined();
    expect(isRegistryRestoreRetryDue({}, 100)).toBe(false);
    expect(isRegistryRestoreRetryDue({ retryAtMs: 101 }, 100)).toBe(false);
    expect(isRegistryRestoreRetryDue({ retryAtMs: 100 }, 100)).toBe(true);
  });

  it("restores the task registry again once a transient failure's retry is due", () => {
    freezeClock();
    const task = createStoredTask();
    const store = failingTaskStore(sqliteError("disk I/O error", 266), task);

    expect(() => getTaskById(task.taskId)).toThrow("Task registry restore failed: disk I/O error");
    store.recover();
    nowMs += RETRY_MS - 1;
    expect(() => getTaskById(task.taskId)).toThrow("Task registry restore failed: disk I/O error");
    expect(store.loadSnapshot).toHaveBeenCalledTimes(1);

    nowMs += 1;
    expect(getTaskById(task.taskId)).toMatchObject({ taskId: task.taskId });
    expect(store.loadSnapshot).toHaveBeenCalledTimes(2);
    expect(() => assertTaskRegistryRestoreNotFailed()).not.toThrow();
  });

  it("keeps a corrupt restore failure sticky past the transient retry time", () => {
    freezeClock();
    const task = createStoredTask();
    const store = failingTaskStore(sqliteError("database disk image is malformed", 11), task);

    expect(() => getTaskById(task.taskId)).toThrow("database disk image is malformed");
    store.recover();
    nowMs += 10 * 60_000;
    expect(() => getTaskById(task.taskId)).toThrow("database disk image is malformed");
    expect(store.loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps restart-drain delivery failed until a retry restore succeeds", async () => {
    freezeClock();
    const task = createStoredTask();
    const store = failingTaskStore(sqliteError("disk I/O error", 266), task);
    const deliver = vi.fn(async () => null);

    expect(() => getTaskById(task.taskId)).toThrow("disk I/O error");
    nowMs += RETRY_MS;
    markGatewayRestartDraining();

    // The retry is due but has not run: drain-time delivery must not read the empty projection.
    await expect(runTaskDeliveryWithDetachedAdmission(task.taskId, deliver)).rejects.toThrow(
      "Task registry restore failed: disk I/O error",
    );
    expect(deliver).not.toHaveBeenCalled();
    expect(store.loadSnapshot).toHaveBeenCalledTimes(1);

    store.recover();
    expect(getTaskById(task.taskId)).toMatchObject({ taskId: task.taskId });
    await expect(runTaskDeliveryWithDetachedAdmission(task.taskId, deliver)).resolves.toMatchObject(
      { taskId: task.taskId },
    );
    expect(deliver).not.toHaveBeenCalled();
  });

  it("restores the task-flow registry again once a transient failure's retry is due", () => {
    freezeClock();
    const flow: TaskFlowRecord = {
      flowId: "transient-flow",
      syncMode: "managed",
      ownerKey: "agent:main:main",
      controllerId: "tests/transient-flow",
      revision: 1,
      status: "running",
      notifyPolicy: "done_only",
      goal: "Survives a transient restore failure",
      createdAt: 10,
      updatedAt: 20,
    };
    const loadSnapshot = vi
      .fn()
      .mockImplementationOnce(() => {
        throw sqliteError("disk I/O error", 10);
      })
      .mockReturnValue({ flows: new Map([[flow.flowId, flow]]) });
    configureTaskFlowRegistryRuntime({
      store: {
        ...createInMemoryTaskFlowRegistryStore(),
        loadSnapshot,
        withSnapshotAsync: async (_context, consume) => consume(loadSnapshot()),
      },
    });

    expect(() => listTaskFlowRecords()).toThrow(
      "Task-flow registry restore failed: disk I/O error",
    );
    nowMs += RETRY_MS - 1;
    expect(getTaskFlowRegistryRestoreFailure()).toBe("disk I/O error");
    nowMs += 1;
    expect(listTaskFlowRecords().map((record) => record.flowId)).toEqual([flow.flowId]);
    expect(getTaskFlowRegistryRestoreFailure()).toBeNull();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });
});
