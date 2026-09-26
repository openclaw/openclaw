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
import {
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  DetachedTaskRuntimeOwnerRetiredError,
  type CreatedDetachedTaskRun,
} from "./detached-task-runtime-contract.js";
import { DetachedTaskLegacyRuntimeError } from "./detached-task-runtime-errors.js";
import { finalizeTaskRunByRunIdAsync } from "./detached-task-runtime.async.js";
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
  transitionTaskAssignment,
  tryRecoverTaskBeforeMarkLost,
} from "./detached-task-runtime.js";
import { captureTaskPersistenceReceipt } from "./task-registry-records.js";
import * as taskTransitions from "./task-registry-transition.async.js";
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
  it("rejects unsupported exact settlement without bypassing the legacy adapter", () => {
    const task = createFakeTaskRecord();
    const complete = vi.fn(() => [task]);
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      transitionTaskAssignment: undefined,
      finalizeTaskRunByRunId: undefined,
      completeTaskRunByRunId: complete,
    });
    expect(() =>
      transitionTaskAssignment({
        expectedTask: captureTaskPersistenceReceipt(task),
        transition: {
          kind: "state",
          params: { runId: task.runId!, status: "succeeded", endedAt: 2 },
        },
        assertCurrent: () => {},
      }),
    ).toThrow("must implement transitionTaskAssignment");
    expect(complete).not.toHaveBeenCalled();
    expect(mockCreateRunningTaskRunCore).not.toHaveBeenCalled();
    finalizeTaskRunByRunId({ runId: task.runId!, status: "succeeded", endedAt: 2 });
    expect(complete).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "rechecks a registered exact-transition owner before commit (replace=%s)",
    (replace) => {
      const task = createFakeTaskRecord();
      const expectedTask = captureTaskPersistenceReceipt(task);
      const committed = vi.fn();
      const adapter = {
        ...getDetachedTaskLifecycleRuntime(),
        transitionTaskAssignment: vi.fn((input: Parameters<typeof transitionTaskAssignment>[0]) => {
          expect(input.expectedTask).toBe(expectedTask);
          if (replace) {
            setDetachedTaskLifecycleRuntime({ ...adapter });
          }
          input.assertCurrent();
          committed();
          return [task];
        }),
      };
      setDetachedTaskLifecycleRuntime(adapter);
      const settle = () =>
        transitionTaskAssignment({
          expectedTask,
          transition: {
            kind: "delivery",
            params: { runId: task.runId!, deliveryStatus: "delivered" },
          },
          assertCurrent: () => {},
        });
      if (replace) {
        expect(settle).toThrow(DetachedTaskRuntimeOwnerRetiredError);
      } else {
        expect(settle()).toEqual([task]);
      }
      expect(committed).toHaveBeenCalledTimes(replace ? 0 : 1);
    },
  );

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

  it.each([
    {
      name: "Gateway A's core-owned successor while Gateway B is live and active",
      gatewayB: true,
      settles: true,
    },
    {
      name: "a successor that registers a plugin task runtime",
      successorRuntime: true,
      settles: false,
    },
    {
      name: "a closing Gateway A while Gateway B is live and active",
      gatewayB: true,
      closeGatewayA: true,
      settles: false,
    },
    {
      // A published build shares this process state but never links its registries.
      name: "a generation left unlinked by a published build while Gateway B is live and active",
      unlinked: true,
      gatewayB: true,
      settles: false,
    },
  ])(
    "settles, but never admits, work from a replaced plugin generation on $name",
    async ({ successorRuntime, gatewayB, closeGatewayA, unlinked, settles }) => {
      const task = createFakeTaskRecord();
      const transition = vi
        .spyOn(taskTransitions, "transitionTaskRecordsByRunAsync")
        .mockResolvedValue([task]);
      const spawning = createEmptyPluginRegistry();
      setActivePluginRegistry(spawning);
      const gatewayA = unlinked ? undefined : createPluginRegistryOwner(spawning);
      try {
        // A plugin reload publishes Gateway A's successor and retires the admitting generation.
        const successor = createEmptyPluginRegistry();
        setActivePluginRegistry(successor);
        gatewayA?.publish(successor);
        markPluginRegistryRetired(spawning);
        if (successorRuntime) {
          setDetachedTaskLifecycleRuntime({ ...getDetachedTaskLifecycleRuntime() });
        }
        if (gatewayB) {
          // Gateway B becomes the process-active projection; it never succeeds A.
          const other = createEmptyPluginRegistry();
          setActivePluginRegistry(other);
          createPluginRegistryOwner(other);
        }
        if (closeGatewayA) {
          await gatewayA?.close();
        }
        // The retired scope cannot admit new work, even while core owns tasks.
        expect(() =>
          withPluginRuntimeRegistryScope(spawning, () =>
            createPreparedRunningTask({
              runtime: "subagent",
              ownerKey: "agent:main:main",
              runId: "run-after-retirement",
              task: "new work from a retired scope",
            }),
          ),
        ).toThrow(DetachedTaskRuntimeOwnerRetiredError);
        expect(mockCreateRunningTaskRunCoreWithReceiptAsync).not.toHaveBeenCalled();
        expect(mockCreateRunningTaskRunCore).not.toHaveBeenCalled();
        // Work it already admitted still settles.
        const settlement = withPluginRuntimeRegistryScope(spawning, () =>
          finalizeTaskRunByRunIdAsync({ runId: task.runId!, status: "succeeded", endedAt: 200 }),
        );
        if (settles) {
          await expect(settlement).resolves.toEqual([task]);
          expect(transition).toHaveBeenCalledOnce();
        } else {
          await expect(settlement).rejects.toBeInstanceOf(DetachedTaskRuntimeOwnerRetiredError);
          expect(transition).not.toHaveBeenCalled();
        }
      } finally {
        transition.mockRestore();
        resetPluginRuntimeStateForTest();
      }
    },
  );

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

    it.each(["finalize", "complete", "fail"] as const)(
      "projects Incognito content before a legacy runtime's create and %s callbacks",
      async (terminalMethod) =>
        withRuntimeOwner(async () => {
          const content = "Synthetic private legacy task content";
          const writes: unknown[] = [];
          const task = createFakeTaskRecord();
          const finish = (terminal: { runId: string }) => {
            writes.push(structuredClone(terminal));
            return [task];
          };
          setDetachedTaskLifecycleRuntime({
            ...getDetachedTaskLifecycleRuntime(),
            createRunningTaskRun(input) {
              writes.push(structuredClone(input));
              return task;
            },
            finalizeTaskRunByRunId: terminalMethod === "finalize" ? finish : undefined,
            completeTaskRunByRunId: finish,
            failTaskRunByRunId: finish,
          });
          for (const incognito of [false, true]) {
            writes.length = 0;
            const prepared = prepareRunningTaskRun({
              ...params,
              ownerKey: incognito
                ? "agent:main:dashboard:incognito-synthetic-legacy"
                : params.ownerKey,
              task: content,
              label: content,
              progressSummary: content,
            });
            if (prepared.kind !== "legacy") {
              throw new Error("Expected the registered synchronous runtime");
            }
            prepared.finalizeRun({
              runId: params.runId,
              status: terminalMethod === "complete" ? "succeeded" : "failed",
              endedAt: 200,
              terminalSummary: content,
              error: content,
            });
            expect.soft(writes).toEqual([
              expect.objectContaining({
                task: incognito ? "Incognito task" : content,
                label: incognito ? "Incognito task" : content,
                progressSummary: incognito ? null : content,
              }),
              expect.objectContaining({
                terminalSummary: incognito ? null : content,
                error: incognito ? "Incognito task error." : content,
              }),
            ]);
          }
        }),
    );

    it.each(["core", "legacy"] as const)(
      "preserves %s failure custody without retrying the write",
      async (owner) =>
        withRuntimeOwner(async () => {
          const failure = new Error("Task write outcome unavailable");
          const transition = vi
            .spyOn(taskTransitions, "transitionTaskRecordsByRunAsync")
            .mockRejectedValue(failure);
          const legacy = vi.fn(() => {
            throw failure;
          });
          if (owner === "legacy") {
            setDetachedTaskLifecycleRuntime({
              ...getDetachedTaskLifecycleRuntime(),
              finalizeTaskRunByRunId: legacy,
            });
          }
          try {
            const result = finalizeTaskRunByRunIdAsync({
              runId: params.runId,
              status: "succeeded",
              endedAt: 200,
            });
            if (owner === "core") {
              await expect(result).rejects.toBe(failure);
              expect(transition).toHaveBeenCalledOnce();
              expect(legacy).not.toHaveBeenCalled();
            } else {
              await expect(result).rejects.toBeInstanceOf(DetachedTaskLegacyRuntimeError);
              await expect(result).rejects.toMatchObject({
                message: failure.message,
                cause: failure,
              });
              expect(legacy).toHaveBeenCalledOnce();
              expect(transition).not.toHaveBeenCalled();
            }
          } finally {
            transition.mockRestore();
          }
        }),
    );

    it.each(["succeeded", "failed"] as const)(
      "keeps legacy %s callbacks synchronous when the optional finalizer is absent",
      async (status) =>
        withRuntimeOwner(async () => {
          const task = createFakeTaskRecord({ status, endedAt: 200 });
          const complete = vi.fn(() => [task]);
          const fail = vi.fn(() => [task]);
          setDetachedTaskLifecycleRuntime({
            ...getDetachedTaskLifecycleRuntime(),
            finalizeTaskRunByRunId: undefined,
            completeTaskRunByRunId: complete,
            failTaskRunByRunId: fail,
          });
          const terminal = { runId: task.runId!, status, endedAt: 200 };
          const pending = finalizeTaskRunByRunIdAsync(terminal);
          expect(status === "succeeded" ? complete : fail).toHaveBeenCalledExactlyOnceWith(
            terminal,
          );
          expect(status === "succeeded" ? fail : complete).not.toHaveBeenCalled();
          await expect(pending).resolves.toEqual([task]);
        }),
    );

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

  it("dispatches lifecycle operations through the installed runtime", () => {
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
