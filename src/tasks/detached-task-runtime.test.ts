// Covers detached task runtime spawning, events, and cancellation handling.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
  revokePluginRecord,
} from "../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { CreatedDetachedTaskRun } from "./detached-task-runtime-contract.js";
import {
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  prepareRunningTaskRun,
  failTaskRunByRunId,
  findDetachedTaskRun,
  finalizeTaskRunByRunId,
  getDetachedTaskLifecycleRuntime,
  recordTaskRunProgressByRunId,
  setDetachedTaskDeliveryStatusByRunId,
  startTaskRunByRunId,
  tryRecoverTaskBeforeMarkLost,
} from "./detached-task-runtime.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "./task-runtime.test-helpers.js";

const {
  mockFindTaskByRunIdForStatus,
  mockListTasksForSessionKeyForStatus,
  mockLogWarn,
  mockCreateQueuedTaskRunCore,
  mockCreateRunningTaskRunCore,
  mockCreateRunningTaskRunCoreWithReceiptAsync,
} = vi.hoisted(() => ({
  mockFindTaskByRunIdForStatus: vi.fn(),
  mockListTasksForSessionKeyForStatus: vi.fn(() => [] as TaskRecord[]),
  mockLogWarn: vi.fn(),
  mockCreateQueuedTaskRunCore: vi.fn<typeof import("./task-executor.js").createQueuedTaskRunCore>(
    () => {
      throw new Error("Unexpected synchronous core task creation");
    },
  ),
  mockCreateRunningTaskRunCore: vi.fn<typeof import("./task-executor.js").createRunningTaskRunCore>(
    () => {
      throw new Error("Unexpected synchronous core task creation");
    },
  ),
  mockCreateRunningTaskRunCoreWithReceiptAsync:
    vi.fn<
      typeof import("./task-executor-create.async.js").createRunningTaskRunCoreWithReceiptAsync
    >(),
}));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    subsystem: "tasks/detached-runtime",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  }),
}));

vi.mock("./task-status-access.js", () => ({
  findTaskByRunIdForStatus: mockFindTaskByRunIdForStatus,
  listTasksForSessionKeyForStatus: mockListTasksForSessionKeyForStatus,
}));

vi.mock("./task-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./task-executor.js")>()),
  createQueuedTaskRunCore: mockCreateQueuedTaskRunCore,
  createRunningTaskRunCore: mockCreateRunningTaskRunCore,
}));

vi.mock("./task-executor-create.async.js", () => ({
  createRunningTaskRunCoreWithReceiptAsync: mockCreateRunningTaskRunCoreWithReceiptAsync,
}));

function createFakeTaskRecord(overrides?: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: "task-fake",
    runtime: "cli",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    runId: "run-fake",
    task: "Fake task",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: 1,
    ...overrides,
  };
}

function createPreparedRunningTask(...args: Parameters<typeof prepareRunningTaskRun>) {
  const prepared = prepareRunningTaskRun(...args);
  return prepared.kind === "receipt"
    ? prepared.create()
    : Promise.resolve(prepared.task ? { task: prepared.task } : null);
}

function createFakeTaskReceipt(task: TaskRecord): CreatedDetachedTaskRun {
  return {
    task,
    bindRunOwner: async () => {
      throw new Error("This fixture does not bind task owners");
    },
    settleUnstarted: async () => false,
    finalizeActive: async () => undefined,
  };
}

function findWarningPayload(message: string): Record<string, unknown> | undefined {
  const payload = mockLogWarn.mock.calls.find(([entry]) => entry === message)?.[1];
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
}

function requireFirstCallArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error(`expected ${label} params to be an object`);
  }
  return arg as Record<string, unknown>;
}

describe("detached-task-runtime", () => {
  afterEach(() => {
    resetDetachedTaskLifecycleRuntimeForTests();
    mockFindTaskByRunIdForStatus.mockReset();
    mockListTasksForSessionKeyForStatus.mockReset();
    mockListTasksForSessionKeyForStatus.mockReturnValue([]);
    mockLogWarn.mockClear();
    mockCreateQueuedTaskRunCore.mockReset();
    mockCreateRunningTaskRunCore.mockReset();
    mockCreateRunningTaskRunCoreWithReceiptAsync.mockReset();
  });

  describe("awaited creation", () => {
    async function withRuntimeOwner(
      run: (registry: ReturnType<typeof createEmptyPluginRegistry>) => Promise<void>,
    ) {
      const registry = createEmptyPluginRegistry();
      registry.plugins.push(
        createPluginRecord({
          id: "__test__",
          source: "/plugins/task-owner/index.js",
          origin: "config",
          enabled: true,
          configSchema: true,
        }),
      );
      markPluginRegistryActive(registry);
      try {
        await withPluginRuntimeRegistryScope(registry, () => run(registry));
      } finally {
        markPluginRegistryRetired(registry);
      }
    }

    const params = {
      runtime: "cli",
      ownerKey: "agent:main:main",
      runId: "run-owned",
      task: "Owned task",
    } as const;

    it.each(["adopted", "revoked", "runtime replaced", "instance retired"] as const)(
      "retains legacy finalization only while its adopted instance is live: %s",
      async (lifecycle) =>
        withRuntimeOwner(async (registry) => {
          const record = registry.plugins[0]!;
          const instance = new PluginInstance(record.id, { record, registry });
          const successor = createEmptyPluginRegistry();
          let task = createFakeTaskRecord({ runId: params.runId });
          const finalize = vi.fn((terminal: { status: TaskRecord["status"]; endedAt: number }) => {
            task = { ...task, status: terminal.status, endedAt: terminal.endedAt };
            return [task];
          });
          const runtime = instance.wrap({
            ...getDetachedTaskLifecycleRuntime(),
            createRunningTaskRun: () => task,
            finalizeTaskRunByRunId: finalize,
          });
          setDetachedTaskLifecycleRuntime(runtime);
          try {
            const prepared = prepareRunningTaskRun(params);
            if (prepared.kind !== "legacy") {
              throw new Error("Expected the registered synchronous runtime");
            }
            successor.plugins.push(record);
            successor.detachedTaskRuntimes.push({ pluginId: record.id, runtime });
            markPluginRegistryActive(successor);
            markPluginRegistryRetired(registry);
            if (lifecycle === "revoked") {
              revokePluginRecord(successor, record);
            } else if (lifecycle === "runtime replaced") {
              successor.detachedTaskRuntimes[0] = {
                pluginId: record.id,
                runtime: { ...runtime },
              };
            } else if (lifecycle === "instance retired") {
              await instance.dispose();
            }
            const finish = () =>
              prepared.finalizeRun({ runId: params.runId, status: "succeeded", endedAt: 200 });
            if (lifecycle === "adopted") {
              expect(finish()).toEqual([task]);
              expect(task.status).toBe("succeeded");
              expect(finalize).toHaveBeenCalledOnce();
            } else {
              expect(finish).toThrow("Detached task runtime owner changed");
              expect(task.status).toBe("running");
              expect(finalize).not.toHaveBeenCalled();
            }
          } finally {
            markPluginRegistryRetired(successor);
            await instance.dispose();
          }
        }),
    );

    it.each(["core", "legacy"] as const)(
      "keeps receipt creation with the selected %s owner",
      async (owner) =>
        withRuntimeOwner(async () => {
          const continueWrite = createDeferred();
          const persisted: TaskRecord[] = [];
          const persist = (mode: string, status: TaskRecord["status"]) => {
            const task = createFakeTaskRecord({ taskId: `${mode}-${status}`, status });
            persisted.push(task);
            return task;
          };
          mockCreateRunningTaskRunCoreWithReceiptAsync.mockImplementation(
            async (_input, assertCurrent) => {
              await continueWrite.promise;
              assertCurrent?.();
              return createFakeTaskReceipt(persist("core", "running"));
            },
          );
          if (owner === "legacy") {
            setDetachedTaskLifecycleRuntime({
              ...getDetachedTaskLifecycleRuntime(),
              createRunningTaskRun: () => persist("legacy", "running"),
            });
          }

          const creation = createPreparedRunningTask(params);
          if (owner === "core") {
            expect(persisted).toEqual([]);
          } else {
            expect(persisted.map((task) => task.taskId)).toEqual(["legacy-running"]);
          }
          continueWrite.resolve();
          const receipt = await creation;

          expect(receipt?.task.taskId).toBe(`${owner}-running`);
          expect(persisted).toEqual([receipt?.task]);
        }),
    );

    it("propagates a core async creation failure without synchronous replay", async () =>
      withRuntimeOwner(async () => {
        const failure = new Error("Core worker refused persistence");
        const persisted: TaskRecord[] = [];
        mockCreateRunningTaskRunCore.mockImplementation(() => {
          const task = createFakeTaskRecord();
          persisted.push(task);
          return task;
        });
        mockCreateRunningTaskRunCoreWithReceiptAsync.mockRejectedValue(failure);

        await expect(createPreparedRunningTask(params)).rejects.toBe(failure);
        expect(persisted).toEqual([]);
      }));

    it.each([
      "caller",
      "registered runtime",
      "registry reactivation",
      "registry activation epoch",
      "registration replacement",
    ] as const)(
      "refuses persistence when the %s changes during core preparation",
      async (retiredOwner) =>
        withRuntimeOwner(async (registry) => {
          const prepared = createDeferred();
          const continueWrite = createDeferred();
          const persisted: TaskRecord[] = [];
          let callerCurrent = true;
          const selectedDefault = getDetachedTaskLifecycleRuntime();
          mockCreateRunningTaskRunCoreWithReceiptAsync.mockImplementation(
            async (_input, assertCurrent) => {
              if (!assertCurrent) {
                throw new Error("Expected task creation admission");
              }
              prepared.resolve();
              await continueWrite.promise;
              assertCurrent();
              const task = createFakeTaskRecord();
              persisted.push(task);
              return createFakeTaskReceipt(task);
            },
          );
          const creation = createPreparedRunningTask(params, () => {
            if (!callerCurrent) {
              throw new Error("Caller retired");
            }
          });
          await Promise.race([prepared.promise, creation]);
          if (retiredOwner === "caller") {
            callerCurrent = false;
          } else if (retiredOwner === "registered runtime") {
            setDetachedTaskLifecycleRuntime({ ...selectedDefault });
          } else if (retiredOwner === "registry reactivation") {
            markPluginRegistryRetired(registry);
            markPluginRegistryActive(registry);
          } else if (retiredOwner === "registry activation epoch") {
            markPluginRegistryActive(registry);
          } else {
            // The runtime pointer stays identical while its registration ownership changes.
            setDetachedTaskLifecycleRuntime(selectedDefault);
          }
          continueWrite.resolve();

          await expect(creation).rejects.toThrow();
          expect(persisted).toEqual([]);
        }),
    );

    it("retains a committed result after rotation and closes its admission", async () =>
      withRuntimeOwner(async () => {
        const committed = createDeferred<() => void>();
        const finishSettlement = createDeferred();
        const persisted: TaskRecord[] = [];
        const task = createFakeTaskRecord({ taskId: "committed-before-rotation" });
        const receipt = createFakeTaskReceipt(task);
        const selectedDefault = getDetachedTaskLifecycleRuntime();
        mockCreateRunningTaskRunCoreWithReceiptAsync.mockImplementation(
          async (_input, assertCurrent) => {
            if (!assertCurrent) {
              throw new Error("Expected task creation admission");
            }
            assertCurrent();
            persisted.push(task);
            committed.resolve(assertCurrent);
            await finishSettlement.promise;
            return receipt;
          },
        );
        const creation = createPreparedRunningTask(params);
        const assertCurrent = await committed.promise;
        setDetachedTaskLifecycleRuntime({ ...selectedDefault });
        finishSettlement.resolve();

        await expect(creation).resolves.toBe(receipt);
        expect(persisted).toEqual([task]);
        resetDetachedTaskLifecycleRuntimeForTests();
        expect(() => assertCurrent()).toThrow(/admission is closed/);
      }));
  });

  it("finds a replacement task within the requested session generation", () => {
    const expected = createFakeTaskRecord({
      taskId: "task-expected",
      runtime: "subagent",
      runId: "run-shared",
      childSessionKey: "agent:main:subagent:expected",
      createdAt: 30,
    });
    mockFindTaskByRunIdForStatus.mockReturnValue(
      createFakeTaskRecord({
        taskId: "task-other-generation",
        runtime: "subagent",
        runId: "run-shared",
        childSessionKey: "agent:main:subagent:other",
        createdAt: 10,
      }),
    );
    mockListTasksForSessionKeyForStatus.mockReturnValue([
      createFakeTaskRecord({
        taskId: "task-next-generation",
        runtime: "subagent",
        runId: "run-next",
        childSessionKey: "agent:main:subagent:expected",
        createdAt: 40,
      }),
      expected,
    ]);

    expect(
      findDetachedTaskRun({
        runId: "run-shared",
        runtime: "subagent",
        sessionKey: "agent:main:subagent:expected",
        createdAtOrAfter: 15,
        createdBefore: 40,
        allowSessionFallback: true,
      }),
    ).toEqual({ lookup: "available", task: expected });
  });

  it("uses an exact task owner even when its timestamps predate the current run", () => {
    const expected = createFakeTaskRecord({
      taskId: "task-original-owner",
      runtime: "subagent",
      runId: "run-original-owner",
      childSessionKey: "agent:main:subagent:steered",
      createdAt: 10,
    });
    mockFindTaskByRunIdForStatus.mockReturnValue(expected);

    expect(
      findDetachedTaskRun({
        runId: "run-original-owner",
        runtime: "subagent",
        sessionKey: "agent:main:subagent:steered",
        createdAtOrAfter: 20,
        createdBefore: 20,
      }),
    ).toEqual({ lookup: "available", task: expected });
    expect(mockListTasksForSessionKeyForStatus).not.toHaveBeenCalled();
  });

  it("does not adopt a session task for an unchanged run ID", () => {
    mockListTasksForSessionKeyForStatus.mockReturnValue([
      createFakeTaskRecord({
        taskId: "task-unrelated",
        runtime: "subagent",
        runId: "run-unrelated",
        childSessionKey: "agent:main:subagent:expected",
        createdAt: 30,
      }),
    ]);

    expect(
      findDetachedTaskRun({
        runId: "run-current",
        runtime: "subagent",
        sessionKey: "agent:main:subagent:expected",
        createdAtOrAfter: 15,
        createdBefore: 40,
      }),
    ).toEqual({ lookup: "available", task: undefined });
    expect(mockListTasksForSessionKeyForStatus).not.toHaveBeenCalled();
  });

  it("contains failures from custom task lookup hooks", () => {
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      findTaskRun: () => {
        throw new Error("lookup unavailable");
      },
    });

    expect(
      findDetachedTaskRun({
        runId: "run-lookup-failure",
        runtime: "subagent",
        sessionKey: "agent:main:subagent:lookup-failure",
        createdAtOrAfter: 1,
      }),
    ).toEqual({ lookup: "unavailable" });
    expect(mockLogWarn).toHaveBeenCalledWith(
      "Detached task lookup failed",
      expect.objectContaining({
        runtime: "subagent",
        runId: "run-lookup-failure",
        error: expect.any(Error),
      }),
    );
  });

  it("dispatches lifecycle operations through the installed runtime", async () => {
    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    const queuedTask = createFakeTaskRecord({
      taskId: "task-queued",
      runId: "run-queued",
      status: "queued",
    });
    const runningTask = createFakeTaskRecord({
      taskId: "task-running",
      runId: "run-running",
    });
    const updatedTasks = [runningTask];

    const fakeRuntime: typeof defaultRuntime = {
      createQueuedTaskRun: vi.fn(() => queuedTask),
      createRunningTaskRun: vi.fn(() => runningTask),
      startTaskRunByRunId: vi.fn(() => updatedTasks),
      recordTaskRunProgressByRunId: vi.fn(() => updatedTasks),
      finalizeTaskRunByRunId: vi.fn(() => updatedTasks),
      completeTaskRunByRunId: vi.fn(() => updatedTasks),
      failTaskRunByRunId: vi.fn(() => updatedTasks),
      setDetachedTaskDeliveryStatusByRunId: vi.fn(() => updatedTasks),
      findTaskRun: vi.fn(() => runningTask),
      cancelDetachedTaskRunById: vi.fn(async () => ({
        found: true,
        cancelled: true,
        task: runningTask,
      })),
    };

    setDetachedTaskLifecycleRuntime(fakeRuntime);

    expect(
      createQueuedTaskRun({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterSessionKey: "agent:main:main",
        runId: "run-queued",
        task: "Queue task",
      }),
    ).toBe(queuedTask);
    expect(
      createRunningTaskRun({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterSessionKey: "agent:main:main",
        runId: "run-running",
        task: "Run task",
      }),
    ).toBe(runningTask);

    startTaskRunByRunId({ runId: "run-running", startedAt: 10 });
    recordTaskRunProgressByRunId({ runId: "run-running", lastEventAt: 20 });
    finalizeTaskRunByRunId({ runId: "run-running", status: "succeeded", endedAt: 25 });
    completeTaskRunByRunId({ runId: "run-running", endedAt: 30 });
    failTaskRunByRunId({ runId: "run-running", endedAt: 40 });
    setDetachedTaskDeliveryStatusByRunId({
      runId: "run-running",
      deliveryStatus: "delivered",
    });
    expect(
      findDetachedTaskRun({
        runId: "run-running",
        runtime: "cli",
        sessionKey: "agent:main:main",
        createdAtOrAfter: 1,
      }),
    ).toEqual({ lookup: "available", task: runningTask });
    await getDetachedTaskLifecycleRuntime().cancelDetachedTaskRunById({
      cfg: {} as never,
      taskId: runningTask.taskId,
    });

    const queuedArgs = requireFirstCallArg(vi.mocked(fakeRuntime.createQueuedTaskRun), "queued");
    expect(queuedArgs.runId).toBe("run-queued");
    expect(queuedArgs.task).toBe("Queue task");
    const runningArgs = requireFirstCallArg(vi.mocked(fakeRuntime.createRunningTaskRun), "running");
    expect(runningArgs.runId).toBe("run-running");
    expect(runningArgs.task).toBe("Run task");
    const startArgs = requireFirstCallArg(vi.mocked(fakeRuntime.startTaskRunByRunId), "start");
    expect(startArgs.runId).toBe("run-running");
    expect(startArgs.startedAt).toBe(10);
    const progressArgs = requireFirstCallArg(
      vi.mocked(fakeRuntime.recordTaskRunProgressByRunId),
      "progress",
    );
    expect(progressArgs.runId).toBe("run-running");
    expect(progressArgs.lastEventAt).toBe(20);
    const finalizeMock = fakeRuntime.finalizeTaskRunByRunId;
    if (!finalizeMock) {
      throw new Error("Expected fake runtime finalizer");
    }
    const finalizeArgs = requireFirstCallArg(vi.mocked(finalizeMock), "finalize");
    expect(finalizeArgs.runId).toBe("run-running");
    expect(finalizeArgs.status).toBe("succeeded");
    expect(finalizeArgs.endedAt).toBe(25);
    const completeArgs = requireFirstCallArg(
      vi.mocked(fakeRuntime.completeTaskRunByRunId),
      "complete",
    );
    expect(completeArgs.runId).toBe("run-running");
    expect(completeArgs.endedAt).toBe(30);
    const failArgs = requireFirstCallArg(vi.mocked(fakeRuntime.failTaskRunByRunId), "fail");
    expect(failArgs.runId).toBe("run-running");
    expect(failArgs.endedAt).toBe(40);
    const deliveryArgs = vi.mocked(fakeRuntime.setDetachedTaskDeliveryStatusByRunId).mock
      .calls[0]?.[0];
    expect(deliveryArgs?.runId).toBe("run-running");
    expect(deliveryArgs?.deliveryStatus).toBe("delivered");
    expect(fakeRuntime.findTaskRun).toHaveBeenCalledWith({
      runId: "run-running",
      runtime: "cli",
      sessionKey: "agent:main:main",
      createdAtOrAfter: 1,
    });
    expect(fakeRuntime.cancelDetachedTaskRunById).toHaveBeenCalledWith({
      cfg: {} as never,
      taskId: runningTask.taskId,
    });

    resetDetachedTaskLifecycleRuntimeForTests();
    expect(getDetachedTaskLifecycleRuntime()).toBe(defaultRuntime);
  });

  it("falls back to legacy complete and fail hooks when a runtime has no finalizer", () => {
    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    const completeTaskRunByRunIdSpy = vi.fn(
      (_params: Parameters<typeof completeTaskRunByRunId>[0]) => [],
    );
    const failTaskRunByRunIdSpy = vi.fn((_params: Parameters<typeof failTaskRunByRunId>[0]) => []);
    const legacyRuntime = {
      ...defaultRuntime,
      completeTaskRunByRunId: completeTaskRunByRunIdSpy,
      failTaskRunByRunId: failTaskRunByRunIdSpy,
    };
    delete legacyRuntime.finalizeTaskRunByRunId;

    setDetachedTaskLifecycleRuntime(legacyRuntime);

    finalizeTaskRunByRunId({ runId: "legacy-ok", status: "succeeded", endedAt: 10 });
    finalizeTaskRunByRunId({ runId: "legacy-timeout", status: "timed_out", endedAt: 20 });

    const completeArgs = requireFirstCallArg(completeTaskRunByRunIdSpy, "legacy complete");
    expect(completeArgs.runId).toBe("legacy-ok");
    expect(completeArgs.status).toBe("succeeded");
    expect(completeArgs.endedAt).toBe(10);
    const failArgs = requireFirstCallArg(failTaskRunByRunIdSpy, "legacy fail");
    expect(failArgs.runId).toBe("legacy-timeout");
    expect(failArgs.status).toBe("timed_out");
    expect(failArgs.endedAt).toBe(20);
  });

  it("reports unavailable lookup for an opaque legacy runtime", () => {
    const legacyRuntime = { ...getDetachedTaskLifecycleRuntime() };
    delete legacyRuntime.findTaskRun;
    setDetachedTaskLifecycleRuntime(legacyRuntime);

    expect(
      findDetachedTaskRun({
        runId: "run-not-mirrored",
        runtime: "subagent",
        sessionKey: "agent:main:subagent:not-mirrored",
        createdAtOrAfter: 1,
      }),
    ).toEqual({ lookup: "unavailable" });
  });

  describe("tryRecoverTaskBeforeMarkLost", () => {
    it("returns recovered when hook returns recovered true", async () => {
      const task = createFakeTaskRecord({ taskId: "task-recover", runtime: "subagent" });
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        tryRecoverTaskBeforeMarkLost: vi.fn(() => ({ recovered: true })),
      });
      const result = await tryRecoverTaskBeforeMarkLost({
        taskId: task.taskId,
        runtime: task.runtime,
        task,
        now: 123,
      });
      expect(result).toEqual({ recovered: true });
    });

    it("returns not recovered when hook returns recovered false", async () => {
      const task = createFakeTaskRecord({ taskId: "task-no-recover", runtime: "cron" });
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        tryRecoverTaskBeforeMarkLost: vi.fn(() => ({ recovered: false })),
      });
      const result = await tryRecoverTaskBeforeMarkLost({
        taskId: task.taskId,
        runtime: task.runtime,
        task,
        now: 456,
      });
      expect(result).toEqual({ recovered: false });
    });

    it("returns not recovered when hook is not provided", async () => {
      const task = createFakeTaskRecord({ taskId: "task-no-hook", runtime: "cli" });
      const result = await tryRecoverTaskBeforeMarkLost({
        taskId: task.taskId,
        runtime: task.runtime,
        task,
        now: 789,
      });
      expect(result).toEqual({ recovered: false });
    });

    it("returns not recovered and logs warning when hook throws", async () => {
      const task = createFakeTaskRecord({ taskId: "task-throw", runtime: "acp" });
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        tryRecoverTaskBeforeMarkLost: vi.fn(() => {
          throw new Error("plugin crashed");
        }),
      });
      const result = await tryRecoverTaskBeforeMarkLost({
        taskId: task.taskId,
        runtime: task.runtime,
        task,
        now: 1_000,
      });
      expect(result).toEqual({ recovered: false });
      const warningPayload = findWarningPayload(
        "Detached task recovery hook threw, proceeding with markTaskLost",
      );
      expect(warningPayload?.taskId).toBe("task-throw");
      expect(warningPayload?.runtime).toBe("acp");
      expect(typeof warningPayload?.elapsedMs).toBe("number");
      if (typeof warningPayload?.elapsedMs !== "number") {
        throw new Error("Expected detached task recovery warning elapsedMs");
      }
      expect(warningPayload.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it("returns not recovered and logs warning when hook returns invalid result", async () => {
      const task = createFakeTaskRecord({ taskId: "task-invalid", runtime: "cron" });
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        tryRecoverTaskBeforeMarkLost: vi.fn(() => ({ nope: true }) as never),
      });
      const result = await tryRecoverTaskBeforeMarkLost({
        taskId: task.taskId,
        runtime: task.runtime,
        task,
        now: 2_000,
      });
      expect(result).toEqual({ recovered: false });
      const warningPayload = findWarningPayload(
        "Detached task recovery hook returned invalid result, proceeding with markTaskLost",
      );
      expect(warningPayload?.taskId).toBe("task-invalid");
      expect(warningPayload?.runtime).toBe("cron");
    });

    it("logs when the recovery hook is slow", async () => {
      const task = createFakeTaskRecord({ taskId: "task-slow", runtime: "subagent" });
      const dateNowSpy = vi.spyOn(Date, "now");
      dateNowSpy.mockReturnValueOnce(10_000).mockReturnValueOnce(16_000);
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        tryRecoverTaskBeforeMarkLost: vi.fn(async () => ({ recovered: true })),
      });
      const result = await tryRecoverTaskBeforeMarkLost({
        taskId: task.taskId,
        runtime: task.runtime,
        task,
        now: 3_000,
      });
      expect(result).toEqual({ recovered: true });
      const warningPayload = findWarningPayload("Detached task recovery hook was slow");
      expect(warningPayload?.taskId).toBe("task-slow");
      expect(warningPayload?.runtime).toBe("subagent");
      expect(warningPayload?.elapsedMs).toBe(6_000);
      dateNowSpy.mockRestore();
    });
  });
});
