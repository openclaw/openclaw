import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import { applyTaskRegistryMaintenanceRetention } from "./task-registry-maintenance-retention.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import {
  getTaskById,
  listFreshTasksForOwnerKey,
  listTaskRecordsForOwnerTree,
  listTaskRecordPage,
  listTaskSessionActivity,
  resetTaskRegistryForTests,
} from "./task-registry-query.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { markTaskTerminalById, updateTaskNotifyPolicyById } from "./task-registry-record-api.js";
import {
  invalidateTaskRegistryProjection,
  readTaskRegistryRevision,
  reloadTaskRegistryFromStoreAsync,
  tasks as authoritativeTasks,
} from "./task-registry-state.js";
import { configureTaskRegistryRuntime, type TaskRegistryStore } from "./task-registry.store.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import type { TaskRecord } from "./task-registry.types.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests();
});

function configureTaskSnapshot(tasks: Iterable<TaskRecord>) {
  const snapshotTasks = new Map([...tasks].map((task) => [task.taskId, task]));
  const store = createInMemoryTaskRegistryStore({
    tasks: snapshotTasks,
    deliveryStates: new Map(),
  });
  configureTaskRegistryRuntime({ store });
  return store;
}

async function readTaskPage(params: Parameters<typeof listTaskRecordPage>[0]) {
  const result = await listTaskRecordPage(params);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`task page failed: ${result.error}`);
  }
  return result.value;
}

describe("listTaskSessionActivity", () => {
  it("copies current session activity without retaining or cloning task payloads", async () => {
    const task: TaskRecord = {
      taskId: "media",
      runtime: "cli",
      requesterSessionKey: "agent:main:requester",
      ownerKey: "agent:main:owner",
      scopeKind: "session",
      taskKind: "image_generation",
      task: "Generate an image",
      status: "queued",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 1,
      detail: { nested: { value: "retained" } },
      executionOwner: { host: "fixture", pid: 1, startIdentity: 1 },
    };
    const other = { ...task, taskId: "other", taskKind: undefined, createdAt: 2 };
    const store = configureTaskSnapshot([task, other]);
    const activity = listTaskSessionActivity();
    const clone = vi.spyOn(globalThis, "structuredClone");
    expect(listTaskSessionActivity()).toEqual(activity);
    expect(clone).not.toHaveBeenCalled();
    clone.mockRestore();
    expect(activity).toEqual([
      {
        taskKind: "image_generation",
        status: "queued",
        requesterSessionKey: task.requesterSessionKey,
        ownerKey: task.ownerKey,
      },
      {
        taskKind: undefined,
        status: "queued",
        requesterSessionKey: task.requesterSessionKey,
        ownerKey: task.ownerKey,
      },
    ]);
    expectDefined(activity[0], "detached activity").status = "cancelled";
    expect(getTaskById(task.taskId)?.status).toBe("queued");
    const completed = {
      ...task,
      status: "succeeded" as const,
      ownerKey: "new-owner",
      cleanupAfter: 0,
    };
    store.upsertTaskWithDeliveryState({ task: completed });
    publishTaskRecordAfterAtomicStore(completed);
    expect(listTaskSessionActivity()[0]).toMatchObject({
      status: "succeeded",
      ownerKey: "new-owner",
    });
    expect(activity[0]).toMatchObject({ status: "cancelled", ownerKey: task.ownerKey });
    expect(
      await applyTaskRegistryMaintenanceRetention(completed, Date.now(), new Map(), () => {}),
    ).toBe("pruned");
    expect(listTaskSessionActivity()).toEqual([activity[1]]);
  });
});

describe("listTasksForAgentId", () => {
  it("clones only selected details from a 10000-task registry", async () => {
    const records = Array.from({ length: 10_000 }, (_, index): TaskRecord => ({
      taskId: `task-${index}`,
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      agentId: `agent-${index % 100}`,
      executionOwner: { host: "worker.example", pid: 123, startIdentity: 1 },
      task: "Agent task selection",
      status: "queued",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: Math.floor(index / 200),
      detail: { nested: { value: `detail-${index}` } },
    }));
    const store = createInMemoryTaskRegistryStore({
      tasks: new Map(records.map((task) => [task.taskId, task])),
      deliveryStates: new Map(),
    });
    configureTaskRegistryRuntime({ store });
    const prepared = expectDefined(await prepareTaskRegistryRead(), "prepared agent read");
    const revision = readTaskRegistryRevision();
    const read = vi.spyOn(store, "loadSnapshot");
    const write = vi.spyOn(store, "upsertTaskWithDeliveryState");
    const clone = vi.spyOn(globalThis, "structuredClone");

    const selected = prepared.listTasksForAgentId(" agent-17 ");
    const detailClones = clone.mock.calls.length;
    clone.mockRestore();

    // Agent selection keeps insertion order within a creation-time tie, unlike
    // the generic task list's reverse-insertion ordering.
    const expected = Array.from({ length: 50 }, (_, index) => 49 - index).flatMap((group) => [
      records[group * 200 + 17],
      records[group * 200 + 117],
    ]);
    expect(selected).toEqual(expected);
    expect(selected).toHaveLength(100);
    expect(authoritativeTasks.size).toBe(10_000);
    expect(readTaskRegistryRevision()).toBe(revision);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();

    const first = expectDefined(selected[0], "selected task");
    const stored = expectDefined(authoritativeTasks.get(first.taskId), "authoritative task");
    expect(first).not.toBe(stored);
    expect(first.detail).not.toBe(stored.detail);
    expect(first.executionOwner).not.toBe(stored.executionOwner);
    (first.detail as { nested: { value: string } }).nested.value = "edited";
    expectDefined(first.executionOwner, "selected execution owner").host = "edited.example";
    expect(getTaskById(first.taskId)).toEqual(expected[0]);
    expect(stored).toEqual(expected[0]);
    expect(detailClones).toBe(100);
  });

  it("keeps exact agent matching and observes reloaded records", async () => {
    const task: TaskRecord = {
      taskId: "trimmed",
      runtime: "cli",
      requesterSessionKey: "agent:worker:main",
      ownerKey: "agent:worker:main",
      scopeKind: "session",
      agentId: " worker ",
      task: "Agent matching",
      status: "queued",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 1,
    };
    configureTaskSnapshot([
      task,
      { ...task, taskId: "case-sensitive", agentId: "Worker" },
      { ...task, taskId: "requester-only", agentId: undefined, requesterAgentId: "worker" },
    ]);
    let prepared = expectDefined(await prepareTaskRegistryRead(), "prepared agent read");
    expect(prepared.listTasksForAgentId(" worker ")).toEqual([task]);
    expect(prepared.listTasksForAgentId("Worker").map((row) => row.taskId)).toEqual([
      "case-sensitive",
    ]);
    expect(prepared.listTasksForAgentId(" \t ")).toEqual([]);
    expect(prepared.listTasksForAgentId("missing")).toEqual([]);

    const replacement = { ...task, taskId: "replacement", detail: { version: 2 } };
    configureTaskSnapshot([replacement]);
    await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
    prepared = expectDefined(await prepareTaskRegistryRead(), "reloaded agent read");
    expect(prepared.listTasksForAgentId("worker")).toEqual([replacement]);
    expect(getTaskById(task.taskId)).toBeUndefined();
  });
  it("infers agent ids for session-scoped tasks", async () => {
    configureTaskSnapshot([]);
    const created = createTaskFixture("cli", {
      ownerKey: undefined,
      scopeKind: undefined,
      taskKind: "video_generation",
      sourceId: "video_generate:openai",
      requesterSessionKey: "agent:main:discord:direct:123",
      childSessionKey: "agent:main:discord:direct:123",
      runId: "tool:video_generate:agent-index",
      task: "Generate a lobster video",
      notifyPolicy: "silent",
    });

    expect(created.agentId).toBe("main");
    const read = expectDefined(await prepareTaskRegistryRead(), "prepared agent read");
    expect(read.listTasksForAgentId("main").map((task) => task.taskId)).toEqual([created.taskId]);
  });

  it("uses the child session agent for cross-agent background task attribution", async () => {
    configureTaskSnapshot([]);
    const created = createTaskFixture("subagent", {
      childSessionKey: "agent:worker:subagent:child",
      runId: "run-worker-subagent",
      task: "Inspect worker state",
      deliveryStatus: "pending",
    });

    expect(created.agentId).toBe("worker");
    const read = expectDefined(await prepareTaskRegistryRead(), "prepared agent read");
    expect(read.listTasksForAgentId("worker").map((task) => task.taskId)).toEqual([created.taskId]);
    expect(read.listTasksForAgentId("main")).toEqual([]);
  });
});

describe("listTaskRecordsForOwnerTree", () => {
  it("preserves insertion order and detached snapshots across owner changes, cycles, and removal", async () => {
    const root = "agent:main:root";
    const child = "agent:main:child";
    const record = (taskId: string, ownerKey: string): TaskRecord => ({
      taskId,
      runtime: "cli",
      ownerKey,
      requesterSessionKey: ownerKey,
      scopeKind: "session",
      task: taskId,
      status: "queued",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 1,
    });
    const descendant = {
      ...record("descendant", child),
      childSessionKey: root,
      detail: { nested: { value: "original" } },
      executionOwner: { host: "fixture", pid: 1, startIdentity: 1 },
    };
    const parent = {
      ...record("parent", root),
      childSessionKey: child,
      status: "succeeded" as const,
      cleanupAfter: 0,
    };
    const unrelated = record("unrelated", "agent:main:other");
    configureTaskSnapshot([descendant, unrelated, parent]);
    const owners = new Set([root]);
    const before = listTaskRecordsForOwnerTree(owners);
    expect(before.map((task) => task.taskId)).toEqual(["descendant", "parent"]);
    expect(owners).toEqual(new Set([root]));
    const selected = expectDefined(before[0], "descendant snapshot");
    expect(selected.detail).not.toBe(authoritativeTasks.get("descendant")?.detail);
    selected.detail = { changed: true };
    expectDefined(selected.executionOwner, "fixture execution owner").pid = 2;
    expect(getTaskById("descendant")).toMatchObject({
      detail: { nested: { value: "original" } },
      executionOwner: { pid: 1 },
    });
    // Atomic publication owns index rebinding; candidate reads must observe its current edges.
    publishTaskRecordAfterAtomicStore({ ...parent, ownerKey: unrelated.ownerKey });
    expect(listTaskRecordsForOwnerTree(owners)).toEqual([]);
    publishTaskRecordAfterAtomicStore(parent);
    publishTaskRecordAfterAtomicStore({ ...descendant, detail: { changed: "canonical" } });
    expect(before[0]?.detail).toEqual({ changed: true });
    expect(listTaskRecordsForOwnerTree(owners)[0]?.detail).toEqual({ changed: "canonical" });
    expect(
      await applyTaskRegistryMaintenanceRetention(parent, Date.now(), new Map(), () => {}),
    ).toBe("pruned");
    expect(listTaskRecordsForOwnerTree(owners)).toEqual([]);
    publishTaskRecordAfterAtomicStore({ ...parent, scopeKind: "system" });
    expect(listTaskRecordsForOwnerTree(owners)).toEqual([]);
  });
});

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
    let replacement: Promise<void> | undefined;
    const preparedAfterReplacement: string[] = [];
    const tick = () => {
      readsPerTurn.push(reads);
      reads = 0;
      if (!replaced) {
        configureTaskSnapshot([
          { ...expectDefined(records[0], "replacement fixture"), taskId: "replacement" },
        ]);
        replacement = reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
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
      try {
        await replacement;
      } finally {
        spy.mockRestore();
      }
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

  it("uses canonical owner rows despite projection changes during lookup", async () => {
    const storedTask = createStoredTask();
    const loadSnapshot = vi.fn(() => ({
      tasks: new Map(),
      deliveryStates: new Map(),
    }));
    const lookup = createDeferred<TaskRecord[]>();
    const entered = createDeferred();
    const listTasksForOwnerKey = vi.fn<NonNullable<TaskRegistryStore["listTasksForOwnerKey"]>>(
      () => {
        entered.resolve();
        return lookup.promise;
      },
    );
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot,
        listTasksForOwnerKey,
      },
    });

    const pending = listFreshTasksForOwnerKey("agent:main:main");
    await entered.promise;
    invalidateTaskRegistryProjection();
    lookup.resolve([storedTask]);
    const tasks = await pending;

    expect(tasks.map((task) => task.taskId)).toEqual(["task-restored"]);
    const [context, ownerKey, assertCurrent] = expectDefined(
      listTasksForOwnerKey.mock.calls[0],
      "captured owner lookup",
    );
    expect(ownerKey).toBe("agent:main:main");
    expect(() => context.admission.assertCurrent()).not.toThrow();
    expect(assertCurrent).not.toThrow();
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it("uses the current memory snapshot when a delayed owner lookup fails", async () => {
    const storedTask = createStoredTask();
    const lookup = createDeferred<TaskRecord[]>();
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore({
          tasks: new Map([[storedTask.taskId, storedTask]]),
          deliveryStates: new Map(),
        }),
        listTasksForOwnerKey: () => lookup.promise,
      },
    });
    const pending = listFreshTasksForOwnerKey(storedTask.ownerKey);
    updateTaskNotifyPolicyById({ taskId: storedTask.taskId, notifyPolicy: "silent" });
    lookup.reject(new Error("owner lookup unavailable"));
    expect(await pending).toMatchObject([{ taskId: storedTask.taskId, notifyPolicy: "silent" }]);
  });

  it.each(["resolved", "rejected"])(
    "rejects a %s owner lookup after its registry is replaced",
    async (outcome) => {
      const storedTask = createStoredTask();
      const entered = createDeferred();
      const lookup = createDeferred<TaskRecord[]>();
      configureTaskRegistryRuntime({
        store: {
          ...createInMemoryTaskRegistryStore(),
          listTasksForOwnerKey: () => {
            entered.resolve();
            return lookup.promise;
          },
        },
      });
      const pending = listFreshTasksForOwnerKey(storedTask.ownerKey);
      await entered.promise;
      configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
      if (outcome === "resolved") {
        lookup.resolve([storedTask]);
      } else {
        lookup.reject(new Error("owner lookup unavailable"));
      }
      await expect(pending).rejects.toThrow("owner is no longer current");
    },
  );
});
