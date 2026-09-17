import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import {
  getTaskById,
  listFreshTasksForOwnerKey,
  listTaskRecordPage,
  resetTaskRegistryForTests,
} from "./task-registry-query.js";
import {
  captureTaskPageRead,
  configureTaskSnapshot,
  readTaskPage,
} from "./task-registry-query.test-support.js";
import { markTaskTerminalById, updateTaskNotifyPolicyById } from "./task-registry-record-api.js";
import * as taskRegistryState from "./task-registry-state.js";
import {
  reloadTaskRegistryFromStoreAsync,
  runTaskRegistryWorkerMutation,
  tasks as authoritativeTasks,
} from "./task-registry-state.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests();
});

describe("listTaskRecordPage", () => {
  it.each(["converging", "exhausted"] as const)(
    "bounds %s projection preparation without losing pending publication",
    async (change) => {
      const task: TaskRecord = {
        taskId: "preparation-task",
        runtime: "cli",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        task: "Bounded preparation",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
      };
      const store = configureTaskSnapshot([task]);
      const published: string[] = [];
      let reads = 0;
      const invalidations = change === "converging" ? 1 : 3;
      configureTaskRegistryRuntime({
        store: {
          ...store,
          async loadMutationSnapshotAsync() {
            const snapshot = store.loadSnapshot();
            if (reads++ < invalidations) {
              markTaskTerminalById({
                taskId: task.taskId,
                status: "succeeded",
                endedAt: reads + 10,
              });
            }
            return snapshot;
          },
        },
        observers: {
          onEvent: (event) => {
            if (event.kind === "upserted") {
              published.push(event.task.notifyPolicy);
            }
          },
        },
      });
      const read = captureTaskPageRead();
      await readTaskPage({ offset: 0, limit: 1 }, read);
      const release = createDeferred();
      let receipt: TaskRecord | undefined;
      const mutation = runTaskRegistryWorkerMutation(
        {
          admission: read.readContext.admission,
          scope: { taskId: task.taskId, flowId: "preparation-flow" },
          publicationRecords: () => new Map(receipt ? [[receipt.taskId, receipt]] : []),
        },
        async () => {
          await release.promise;
          const current = expectDefined(
            store.loadSnapshot().tasks.get(task.taskId),
            "pending preparation task",
          );
          receipt = { ...current, notifyPolicy: "state_changes" };
          store.upsertTaskWithDeliveryState({ task: receipt });
        },
        async () => store.loadSnapshot(),
      );
      try {
        const page = await listTaskRecordPage({ ...read, offset: 0, limit: 1 });
        if (change === "exhausted") {
          expect(page).toEqual({ ok: false, error: "registry_changed" });
        } else {
          expect(page.ok).toBe(true);
          if (page.ok) {
            expect(page.value.tasks).toMatchObject([{ taskId: task.taskId, status: "succeeded" }]);
          }
        }
      } finally {
        release.resolve();
        await mutation;
      }
      expect(getTaskById(task.taskId)?.notifyPolicy).toBe("state_changes");
      expect(published.filter((policy) => policy === "state_changes")).toEqual(["state_changes"]);
    },
  );

  it.each(["page scan", "page cursor", "owner lookup", "empty owner key"] as const)(
    "revalidates the captured owner before %s after preparation settles",
    async (operation) => {
      const task: TaskRecord = {
        taskId: "prepared-task",
        runtime: "cli",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        task: "Prepared owner read",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
      };
      const lookup = vi.fn(async () => [task]);
      const store = { ...configureTaskSnapshot([task]), listTasksForOwnerKey: lookup };
      configureTaskRegistryRuntime({ store });
      const read = captureTaskPageRead();
      const prepare = taskRegistryState.prepareTaskRegistryProjectionAsync;
      vi.spyOn(taskRegistryState, "prepareTaskRegistryProjectionAsync").mockImplementation(
        (...args) =>
          prepare(...args).then((prepared) => {
            queueMicrotask(() => configureTaskSnapshot([]));
            return prepared;
          }),
      );
      const prepareFilter = vi.fn(() => () => true);
      const pending =
        operation === "page scan" || operation === "page cursor"
          ? listTaskRecordPage({
              ...read,
              offset: 0,
              limit: 1,
              ...(operation === "page cursor" ? { expectedRevision: -1 } : {}),
              prepareFilter,
            })
          : listFreshTasksForOwnerKey(
              read.readContext,
              operation === "empty owner key" ? " " : task.ownerKey,
            );

      await expect(pending).rejects.toThrow("Task registry read owner is no longer current.");
      expect(prepareFilter).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("keeps missing indexed IDs bounded across a yielded registry replacement", async () => {
    let workMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => workMs);
    const sessionKey = "agent:main:reset";
    const records = Array.from({ length: 97 }, (_, index): TaskRecord => ({
      taskId: `task-${index}`,
      runtime: "cli",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      task: "Before replacement",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 1,
    }));
    const store = configureTaskSnapshot(records);
    const read = captureTaskPageRead();
    getTaskById("task-0");
    let reads = 0;
    const readsPerTurn: number[] = [];
    const get = authoritativeTasks.get.bind(authoritativeTasks);
    const spy = vi.spyOn(authoritativeTasks, "get").mockImplementation((id) => {
      reads += 1;
      workMs += 1;
      return get(id);
    });
    let replaced = false;
    let replacement: Promise<void> | undefined;
    const preparedAfterReplacement: string[] = [];
    const tick = () => {
      readsPerTurn.push(reads);
      reads = 0;
      if (!replaced) {
        for (const task of records) {
          store.deleteTaskWithDeliveryState(task.taskId);
        }
        store.upsertTaskWithDeliveryState({
          task: { ...expectDefined(records[0], "replacement fixture"), taskId: "replacement" },
        });
        replacement = reloadTaskRegistryFromStoreAsync(read.readContext);
        replaced = true;
      }
      pending = setImmediate(tick);
    };
    let pending = setImmediate(tick);
    try {
      const page = await readTaskPage(
        {
          offset: 0,
          limit: 10,
          sessionKey,
          prepareFilter: (batch) => {
            if (replaced) {
              preparedAfterReplacement.push(...batch.map((task) => task.taskId));
            }
            return () => true;
          },
        },
        read,
      );
      readsPerTurn.push(reads);
      expect(page.tasks.map((task) => task.taskId)).toEqual(["replacement"]);
      expect(preparedAfterReplacement).toEqual(["replacement"]);
      expect(Math.max(...readsPerTurn)).toBeLessThanOrEqual(32);
    } finally {
      clearImmediate(pending);
      try {
        await replacement;
      } finally {
        spy.mockRestore();
      }
    }
  });

  it.each(["store", "admission", "carried cursor", "cursorless retry"] as const)(
    "handles a bounded yielded page with %s",
    async (change) => {
      let workMs = 0;
      vi.spyOn(performance, "now").mockImplementation(() => workMs);
      configureTaskSnapshot(
        Array.from({ length: 33 }, (_, index): TaskRecord => ({
          taskId: `task-${index}`,
          runtime: "cli",
          requesterSessionKey: "agent:main:main",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          task: "Captured page authority",
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: 1,
        })),
      );
      const read = captureTaskPageRead();
      const first = await readTaskPage({ offset: 0, limit: 1 }, read);
      const retired = new Error("page admission retired");
      let preparedSlices = 0;
      let mutation: TaskRecord | null | undefined;
      const pending = listTaskRecordPage({
        ...read,
        offset: 0,
        limit: 1,
        ...(change === "carried cursor" ? { expectedRevision: first.revision } : {}),
        prepareFilter: () => {
          preparedSlices += 1;
          workMs += 20;
          if (preparedSlices === 1) {
            queueMicrotask(() => {
              if (change === "store") {
                configureTaskSnapshot([]);
              } else if (change === "admission") {
                vi.spyOn(read.readContext.admission, "assertCurrent").mockImplementation(() => {
                  throw retired;
                });
              } else {
                mutation = markTaskTerminalById({
                  taskId: "task-32",
                  status: "succeeded",
                  endedAt: 1_000,
                });
              }
            });
          }
          return () => true;
        },
      });
      if (change === "store") {
        await expect(pending).rejects.toThrow("Task registry read owner is no longer current.");
      } else if (change === "admission") {
        await expect(pending).rejects.toBe(retired);
      } else {
        const page = await pending;
        expect(mutation).toMatchObject({ taskId: "task-32", status: "succeeded" });
        if (change === "carried cursor") {
          expect(page).toEqual({ ok: false, error: "cursor_stale" });
        } else {
          expect(page.ok).toBe(true);
          if (page.ok) {
            expect(page.value.tasks.map((task) => task.taskId)).toEqual(["task-32"]);
            expect(page.value.revision).toBeGreaterThan(first.revision);
            expect(page.value.hasMore).toBe(true);
          }
        }
      }
      if (change === "cursorless retry") {
        expect(preparedSlices).toBeGreaterThan(2);
      } else {
        expect(preparedSlices).toBe(1);
      }
    },
  );

  it.each([
    { scope: "sparse", matching: 1 },
    { scope: "dense", matching: 65 },
  ])("keeps $scope session pages independent of unrelated task activity", async ({ matching }) => {
    let workMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => workMs);
    configureTaskSnapshot(
      Array.from({ length: 65 }, (_, index): TaskRecord => ({
        taskId: `task-${index}`,
        runtime: "cli",
        requesterSessionKey: index < matching ? "agent:main:requested" : "agent:main:unrelated",
        ownerKey: index < matching ? "agent:main:requested" : "agent:main:unrelated",
        scopeKind: "session",
        task: "Scoped task page",
        status: "running",
        deliveryStatus: "pending",
        notifyPolicy: "done_only",
        createdAt: 1,
        lastEventAt: 1,
      })),
    );
    expect(getTaskById("task-0")).toBeDefined();
    let mutations = 0;
    const update = () => {
      mutations += 1;
      markTaskTerminalById({ taskId: "task-64", status: "succeeded", endedAt: mutations + 1 });
      pending = setImmediate(update);
    };
    let pending = setImmediate(update);
    try {
      const page = await listTaskRecordPage({
        ...captureTaskPageRead(),
        offset: 0,
        limit: 1,
        sessionKey: "agent:main:requested",
        prepareFilter: () => {
          workMs += 20;
          return () => true;
        },
      });
      if (matching === 1) {
        expect(page.ok).toBe(true);
        if (page.ok) {
          expect(page.value.tasks.map((task) => task.taskId)).toEqual(["task-0"]);
          expect(page.value.hasMore).toBe(false);
        }
      } else {
        expect(page).toEqual({ ok: false, error: "registry_changed" });
        expect(mutations).toBeGreaterThanOrEqual(3);
      }
    } finally {
      clearImmediate(pending);
    }
  });

  it.each([
    { cost: "cheap", workPerSliceMs: 0 },
    { cost: "expensive", workPerSliceMs: 20 },
  ])(
    "keeps $cost task scans responsive and consistent under continuing activity",
    async ({ workPerSliceMs }) => {
      let workMs = 0;
      vi.spyOn(performance, "now").mockImplementation(() => workMs);
      configureTaskSnapshot(
        Array.from({ length: 512 }, (_, index): TaskRecord => ({
          taskId: `task-${index}`,
          runtime: "cli",
          requesterSessionKey: "agent:main:main",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          task: "Task with queued activity",
          status: "running",
          deliveryStatus: "pending",
          notifyPolicy: "done_only",
          createdAt: 1,
          lastEventAt: 1,
        })),
      );
      let mutations = 0;
      const update = () => {
        mutations += 1;
        markTaskTerminalById({
          taskId: "task-0",
          status: "succeeded",
          endedAt: mutations + 1,
        });
        pending = setImmediate(update);
      };
      let pending: ReturnType<typeof setImmediate> | undefined;
      update();
      try {
        const page = await listTaskRecordPage({
          ...captureTaskPageRead(),
          offset: 0,
          limit: 25,
          prepareFilter: () => {
            workMs += workPerSliceMs;
            return () => true;
          },
        });
        if (workPerSliceMs === 0) {
          expect(page.ok).toBe(true);
          expect(mutations).toBe(1);
          if (page.ok) {
            expect(page.value.tasks).toHaveLength(25);
            expect(page.value.tasks[0]).toMatchObject({ taskId: "task-0", endedAt: 2 });
            expect(page.value.hasMore).toBe(true);
          }
        } else {
          expect(page).toEqual({ ok: false, error: "registry_changed" });
          expect(mutations).toBeGreaterThanOrEqual(3);
        }
      } finally {
        clearImmediate(pending);
      }
    },
  );

  it.each([
    { name: "stale cursor", continuation: true, mutate: true, failLater: false },
    { name: "cursorless retry", continuation: false, mutate: true, failLater: false },
    {
      name: "stale cursor before a later failure",
      continuation: true,
      mutate: true,
      failLater: true,
    },
    {
      name: "valid cursor with a later failure",
      continuation: true,
      mutate: false,
      failLater: true,
    },
  ])("handles yielded task pages with $name", async ({ continuation, mutate, failLater }) => {
    let workMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => workMs);
    const tasks = Array.from({ length: 1_024 }, (_, index): TaskRecord => ({
      taskId: `task-${String(index).padStart(5, "0")}`,
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Task page interrupted by one completion",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "done_only",
      createdAt: 1,
      lastEventAt: 1_024 - index,
    }));
    configureTaskSnapshot(tasks);
    const first = await readTaskPage({ offset: 0, limit: 25 });
    const unchanged = await readTaskPage({
      offset: 25,
      limit: 25,
      expectedRevision: first.revision,
    });
    expect(unchanged.tasks.map((task) => task.taskId)).toEqual(
      tasks.slice(25, 50).map((task) => task.taskId),
    );

    let preparedSlices = 0;
    let scheduled = false;
    let mutation: TaskRecord | null | undefined;
    const accessFailure = new Error("canonical-store collision in a later slice");
    const pendingPage = listTaskRecordPage({
      ...captureTaskPageRead(),
      offset: continuation ? 25 : 0,
      limit: 25,
      ...(continuation ? { expectedRevision: first.revision } : {}),
      prepareFilter: () => {
        preparedSlices += 1;
        workMs += 20;
        if (failLater && preparedSlices > 1) {
          throw accessFailure;
        }
        if (mutate && !scheduled) {
          scheduled = true;
          // The ordinary completion runs when this expensive slice yields.
          queueMicrotask(() => {
            mutation = markTaskTerminalById({
              taskId: "task-01023",
              status: "succeeded",
              endedAt: 2_000,
            });
          });
        }
        return () => true;
      },
    });
    if (!mutate) {
      await expect(pendingPage).rejects.toBe(accessFailure);
      return;
    }
    const page = await pendingPage;
    expect(mutation).toMatchObject({ taskId: "task-01023", status: "succeeded" });
    if (continuation) {
      expect(page).toEqual({ ok: false, error: "cursor_stale" });
      expect(preparedSlices).toBe(1);
    } else {
      expect(page.ok).toBe(true);
      if (page.ok) {
        expect(page.value.tasks.map((task) => task.taskId)).toEqual([
          "task-01023",
          ...tasks.slice(0, 24).map((task) => task.taskId),
        ]);
        expect(page.value.revision).toBeGreaterThan(first.revision);
      }
    }
  });

  it("keeps large page scans responsive and sorts only the selected window", async () => {
    let workMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => workMs);
    const total = 10_000;
    const offset = 13;
    const limit = 7;
    const snapshotTasks = new Map<string, TaskRecord>();
    for (let index = 0; index < total; index += 1) {
      const taskId = `task-${String(index).padStart(5, "0")}`;
      const lastEventAt = Math.floor(((index * 7_919) % total) / 4);
      snapshotTasks.set(taskId, {
        taskId,
        runtime: "cli",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: `run-${index}`,
        task: "Bounded page selection",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "done_only",
        createdAt: 0,
        startedAt: 0,
        lastEventAt,
      });
    }
    const expectedTaskIds = [...snapshotTasks.values()]
      .toSorted(
        (left, right) =>
          (right.lastEventAt ?? 0) - (left.lastEventAt ?? 0) ||
          left.taskId.localeCompare(right.taskId),
      )
      .slice(offset, offset + limit)
      .map((task) => task.taskId);
    configureTaskSnapshot(snapshotTasks.values());

    let eventLoopTurnRan = false;
    const sortedInputLengths: number[] = [];
    const originalToSorted = Array.prototype.toSorted;
    const sortSpy = vi.spyOn(Array.prototype, "toSorted").mockImplementation(function <T>(
      this: T[],
      compareFn?: (left: T, right: T) => number,
    ): T[] {
      const first = this[0];
      if (first && typeof first === "object" && "taskId" in first) {
        sortedInputLengths.push(this.length);
      }
      return Reflect.apply(originalToSorted, this, [compareFn]) as T[];
    });
    try {
      setImmediate(() => {
        eventLoopTurnRan = true;
      });
      const page = await readTaskPage({
        offset,
        limit,
        prepareFilter: () => {
          workMs += 20;
          return () => true;
        },
      });

      expect(page.tasks.map((task) => task.taskId)).toEqual(expectedTaskIds);
      expect(page.hasMore).toBe(true);
      expect(eventLoopTurnRan).toBe(true);
      expect(Math.max(0, ...sortedInputLengths)).toBeLessThanOrEqual(offset + limit);

      sortedInputLengths.length = 0;
      const emptyPage = await readTaskPage({ offset: total + 1, limit: 1 });
      expect(emptyPage).toMatchObject({ tasks: [], hasMore: false });
      expect(sortedInputLengths).toEqual([]);
    } finally {
      sortSpy.mockRestore();
    }
  });

  it("selects the terminal page by completion instead of later activity", async () => {
    const tasks = [
      {
        taskId: "finished-newest",
        endedAt: 300,
        lastEventAt: 100,
      },
      {
        taskId: "legacy-terminal",
        endedAt: undefined,
        lastEventAt: 250,
      },
      {
        taskId: "finished-middle",
        endedAt: 200,
        lastEventAt: 200,
      },
    ].map(({ taskId, endedAt, lastEventAt }): TaskRecord => ({
      taskId,
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: taskId,
      status: "succeeded",
      deliveryStatus: "not_applicable",
      notifyPolicy: "done_only",
      createdAt: 0,
      endedAt,
      lastEventAt,
    }));
    configureTaskSnapshot(tasks);

    const page = await readTaskPage({ offset: 0, limit: 2, sortBy: "endedAt" });

    expect(page.tasks.map((task) => task.taskId)).toEqual(["finished-newest", "legacy-terminal"]);
  });

  it("does not use the executor as the requester owner for a legacy bare task", async () => {
    const task: TaskRecord = {
      taskId: "task-legacy-owner",
      runtime: "subagent",
      requesterSessionKey: "global",
      ownerKey: "global",
      scopeKind: "session",
      childSessionKey: "agent:research:subagent:child",
      agentId: "research",
      runId: "run-legacy-owner",
      task: "Owned by ops, executed by research",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      createdAt: 1,
    };
    configureTaskSnapshot([task]);
    const cfg = {
      session: { scope: "global", store: "/tmp/shared-sessions.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;

    expect(
      (
        await readTaskPage({
          offset: 0,
          limit: 10,
          sessionKey: "global",
          sessionAgentId: "ops",
          cfg,
        })
      ).tasks.map((entry) => entry.taskId),
    ).toEqual([task.taskId]);
    expect(
      (
        await readTaskPage({
          offset: 0,
          limit: 10,
          sessionKey: "global",
          sessionAgentId: "research",
          cfg,
        })
      ).tasks,
    ).toEqual([]);
  });

  it("returns page records isolated from the registry", async () => {
    const task: TaskRecord = {
      taskId: "task-isolated",
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Isolated task",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      createdAt: 1,
      detail: { nested: { value: "original" } },
    };
    configureTaskSnapshot([task]);

    const page = await readTaskPage({ offset: 0, limit: 1 });
    const detail = page.tasks[0]?.detail as { nested: { value: string } } | undefined;
    expect(detail).toBeDefined();
    if (detail) {
      detail.nested.value = "mutated";
    }

    expect(getTaskById(task.taskId)?.detail).toEqual({ nested: { value: "original" } });
  });
});

describe("listFreshTasksForOwnerKey", () => {
  function createStoredTask(): TaskRecord {
    return {
      taskId: "task-restored",
      runtime: "acp",
      sourceId: "run-restored",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:restored",
      runId: "run-restored",
      task: "Restored task",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      createdAt: 100,
      lastEventAt: 100,
    };
  }

  it("uses scoped owner lookups for fresh owner task reads", async () => {
    const storedTask = createStoredTask();
    const loadSnapshot = vi.fn(() => ({
      tasks: new Map(),
      deliveryStates: new Map(),
    }));
    const lookup = createDeferred<TaskRecord[]>();
    const listTasksForOwnerKey = vi.fn(() => lookup.promise);
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot,
        listTasksForOwnerKey,
      },
    });

    const pending = listFreshTasksForOwnerKey(
      captureOpenClawStateWorkerContext(),
      "agent:main:main",
    );
    lookup.resolve([storedTask]);
    const tasks = await pending;

    expect(tasks.map((task) => task.taskId)).toEqual(["task-restored"]);
    expect(listTasksForOwnerKey).toHaveBeenCalledWith(
      expect.objectContaining({ admission: expect.any(Object) }),
      "agent:main:main",
    );
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it("uses the current memory snapshot when a delayed owner lookup fails", async () => {
    const storedTask = createStoredTask();
    const lookup = createDeferred<TaskRecord[]>();
    const started = createDeferred();
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore({
          tasks: new Map([[storedTask.taskId, storedTask]]),
          deliveryStates: new Map(),
        }),
        listTasksForOwnerKey: () => {
          started.resolve();
          return lookup.promise;
        },
      },
    });
    const pending = listFreshTasksForOwnerKey(
      captureOpenClawStateWorkerContext(),
      storedTask.ownerKey,
    );
    await started.promise;
    updateTaskNotifyPolicyById({ taskId: storedTask.taskId, notifyPolicy: "silent" });
    lookup.reject(new Error("owner lookup unavailable"));
    expect(await pending).toMatchObject([{ taskId: storedTask.taskId, notifyPolicy: "silent" }]);
  });
});
