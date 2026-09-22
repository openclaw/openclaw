import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import {
  getTaskById,
  listTaskRecordPage,
  resetTaskRegistryForTests,
} from "./task-registry-query.js";
import { markTaskTerminalById } from "./task-registry-record-api.js";
import { reloadTaskRegistryFromStore, tasks as authoritativeTasks } from "./task-registry-state.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests();
});

function configureTaskSnapshot(tasks: Iterable<TaskRecord>): void {
  const snapshotTasks = new Map([...tasks].map((task) => [task.taskId, task]));
  configureTaskRegistryRuntime({
    store: {
      ...createInMemoryTaskRegistryStore(),
      loadSnapshot: () => ({ tasks: snapshotTasks, deliveryStates: new Map() }),
    },
  });
}

async function readTaskPage(params: Parameters<typeof listTaskRecordPage>[0]) {
  const result = await listTaskRecordPage(params);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`task page failed: ${result.error}`);
  }
  return result.value;
}

describe("listTaskRecordPage", () => {
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
    configureTaskSnapshot(records);
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
    const preparedAfterReplacement: string[] = [];
    const tick = () => {
      readsPerTurn.push(reads);
      reads = 0;
      if (!replaced) {
        configureTaskSnapshot([
          { ...expectDefined(records[0], "replacement fixture"), taskId: "replacement" },
        ]);
        reloadTaskRegistryFromStore();
        replaced = true;
      }
      pending = setImmediate(tick);
    };
    let pending = setImmediate(tick);
    try {
      const page = await readTaskPage({
        offset: 0,
        limit: 10,
        sessionKey,
        prepareFilter: (batch) => {
          if (replaced) {
            preparedAfterReplacement.push(...batch.map((task) => task.taskId));
          }
          return () => true;
        },
      });
      readsPerTurn.push(reads);
      expect(page.tasks.map((task) => task.taskId)).toEqual(["replacement"]);
      expect(preparedAfterReplacement).toEqual(["replacement"]);
      expect(Math.max(...readsPerTurn)).toBeLessThanOrEqual(32);
    } finally {
      clearImmediate(pending);
      spy.mockRestore();
    }
  });

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
