import { describe, expect, it } from "vitest";
import {
  coalesceTaskEvent,
  type CoalescedTaskEvent,
  mergeTaskLists,
  newestTaskSnapshot,
  normalizeTasksCancelResult,
  normalizeTasksGetResult,
  normalizeTasksListResult,
  partitionTasks,
  replayTaskEvents,
  sortTasks,
} from "./data.ts";
import type { TaskSummary } from "./task-summary.ts";

function task(overrides: Partial<TaskSummary> & Pick<TaskSummary, "id" | "status">): TaskSummary {
  return {
    taskId: overrides.id,
    updatedAt: 100,
    ...overrides,
  };
}

describe("task data", () => {
  it("sorts by updated time descending with an id tiebreak", () => {
    const sorted = sortTasks([
      task({ id: "b", status: "queued", updatedAt: 200 }),
      task({ id: "c", status: "completed", updatedAt: 300 }),
      task({ id: "a", status: "running", updatedAt: 200 }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["c", "a", "b"]);
  });

  it("partitions active tasks and caps recent terminal tasks at 50", () => {
    const terminals = Array.from({ length: 55 }, (_, index) =>
      task({ id: `terminal-${index}`, status: "completed", updatedAt: index }),
    );
    const result = partitionTasks([
      task({ id: "running", status: "running", updatedAt: 1000 }),
      task({ id: "queued", status: "queued", updatedAt: 999 }),
      ...terminals,
    ]);
    expect(result.active.map((entry) => entry.id)).toEqual(["queued", "running"]);
    expect(result.recent).toHaveLength(50);
    expect(result.recent[0]?.id).toBe("terminal-54");
  });

  it("keeps active tasks in creation order while their activity changes", () => {
    const oldest = task({
      id: "oldest",
      status: "running",
      createdAt: 100,
      startedAt: 110,
      updatedAt: 500,
    });
    const middle = task({
      id: "middle",
      status: "running",
      createdAt: 200,
      startedAt: 410,
      updatedAt: 600,
    });
    const newest = task({
      id: "newest",
      status: "running",
      createdAt: 300,
      startedAt: 310,
      updatedAt: 700,
    });

    expect(partitionTasks([middle, newest, oldest]).active.map((entry) => entry.id)).toEqual([
      "oldest",
      "middle",
      "newest",
    ]);
    expect(
      partitionTasks([{ ...oldest, updatedAt: 800 }, middle, newest]).active.map(
        (entry) => entry.id,
      ),
    ).toEqual(["oldest", "middle", "newest"]);
  });

  it("orders terminal tasks by completion time instead of later activity", () => {
    const finishedFirst = task({
      id: "finished-first",
      status: "completed",
      createdAt: 100,
      endedAt: 400,
      updatedAt: 900,
    });
    const finishedLast = task({
      id: "finished-last",
      status: "completed",
      createdAt: 200,
      endedAt: 500,
      updatedAt: 600,
    });

    expect(partitionTasks([finishedFirst, finishedLast]).recent.map((entry) => entry.id)).toEqual([
      "finished-last",
      "finished-first",
    ]);
  });

  it("merges task lists by id while preserving newer running snapshots", () => {
    const recentPage = [
      task({ id: "new-terminal", status: "completed", updatedAt: 900 }),
      task({ id: "shared", status: "running", updatedAt: 800 }),
    ];
    const activePage = [
      task({ id: "shared", status: "running", updatedAt: 850 }),
      task({ id: "old-running", status: "running", updatedAt: 10 }),
    ];
    const merged = mergeTaskLists(recentPage, activePage);
    expect(merged.map((entry) => entry.id)).toEqual(["new-terminal", "shared", "old-running"]);
    expect(merged.find((entry) => entry.id === "shared")?.updatedAt).toBe(850);
  });

  it("keeps ten completed same-title tasks distinct when the active page is stale", () => {
    const recentPage = Array.from({ length: 10 }, (_, index) =>
      task({
        id: `task-${index}`,
        status: "completed",
        title: "Concurrent background task",
        updatedAt: 2_000 + index,
      }),
    );
    const staleActivePage = recentPage.map((completed) =>
      task({
        id: completed.id,
        status: "running",
        title: completed.title,
        updatedAt: 1_000,
      }),
    );

    const merged = mergeTaskLists(recentPage, staleActivePage);

    expect(merged).toHaveLength(10);
    expect(new Set(merged.map((entry) => entry.id)).size).toBe(10);
    expect(merged.every((entry) => entry.status === "completed")).toBe(true);
    expect(partitionTasks(merged).active).toEqual([]);
  });

  it.each(["completed", "failed", "cancelled", "timed_out"] as const)(
    "preserves an equally recent %s snapshot regardless of page order",
    (status) => {
      const terminal = task({ id: "shared", status, updatedAt: 200 });
      const running = task({ id: "shared", status: "running", updatedAt: 200 });

      expect(mergeTaskLists([terminal], [running])).toEqual([terminal]);
      expect(mergeTaskLists([running], [terminal])).toEqual([terminal]);
    },
  );

  it("advances equally recent queued snapshots to running regardless of page order", () => {
    const queued = task({
      id: "shared",
      status: "queued",
      updatedAt: 200,
      execution: { state: "queued", lastActivityAt: 400 },
    });
    const running = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      execution: { state: "running", lastActivityAt: 300 },
    });

    expect(mergeTaskLists([queued], [running])).toEqual([running]);
    expect(mergeTaskLists([running], [queued])).toEqual([running]);
  });

  it("keeps the later page's equally current tool progress at the same tool count", () => {
    const previous = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 2,
      lastToolName: "write",
      progressSummary: "Preparing the concurrent task report",
    });
    const progress = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 2,
      lastToolName: "write",
      progressSummary: "Finishing the concurrent task report",
    });

    expect(mergeTaskLists([previous], [progress])).toEqual([progress]);
  });

  it("does not roll back running tool progress from an equally recent stale page", () => {
    const progress = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 2,
      lastToolName: "write",
    });
    const stale = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 1,
      lastToolName: "read",
    });

    expect(mergeTaskLists([progress], [stale])).toEqual([progress]);
    expect(mergeTaskLists([stale], [progress])).toEqual([progress]);
  });

  it("preserves an equally current opened task detail", () => {
    const running = task({ id: "shared", status: "running", updatedAt: 200 });
    const detail = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      prompt: "Inspect the concurrent task owner",
    });

    expect(newestTaskSnapshot(running, detail)).toEqual(detail);
  });

  it("retains current tool progress while adopting an opened task prompt", () => {
    const running = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 2,
      lastToolName: "write",
      progressSummary: "Writing the concurrent task report",
    });
    const detail = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 1,
      lastToolName: "read",
      progressSummary: "Reading the concurrent task report",
      prompt: "Inspect the concurrent task owner",
    });

    expect(newestTaskSnapshot(running, detail)).toEqual({
      ...running,
      prompt: detail.prompt,
    });
  });

  it("does not let an equally current opened detail roll back tool progress", () => {
    const running = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 2,
      lastToolName: "write",
      progressSummary: "Finishing the concurrent task report",
    });
    const detail = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 2,
      lastToolName: "write",
      progressSummary: "Preparing the concurrent task report",
      prompt: "Inspect the concurrent task owner",
    });

    expect(newestTaskSnapshot(running, detail)).toEqual({
      ...running,
      prompt: detail.prompt,
    });
  });

  it.each([
    ["running", 300, 400, 2],
    ["waiting", 300, 400, 2],
    ["running", "1970-01-01T00:00:00.300Z", "1970-01-01T00:00:00.400Z", 2],
    ["waiting", 300, "1970-01-01T00:00:00.400Z", 2],
    ["running", "1970-01-01T00:00:00.300Z", 400, 2],
    // Equivalent timestamps still use tool progress to choose the current snapshot.
    ["waiting", 400, "1970-01-01T00:00:00.400Z", 3],
    ["running", "1970-01-01T00:00:00.400Z", 400, 3],
  ] as const)(
    "keeps the freshest %s execution across tied lifecycle snapshots (%s to %s)",
    (state, staleActivityAt, freshActivityAt, freshToolUseCount) => {
      const stale = task({
        id: "shared",
        status: "running",
        updatedAt: 200,
        toolUseCount: 2,
        execution: {
          state: state === "running" ? "waiting" : "running",
          lastActivityAt: staleActivityAt,
        },
      });
      const fresh = task({
        ...stale,
        toolUseCount: freshToolUseCount,
        execution: {
          state,
          lastActivityAt: freshActivityAt,
          ...(state === "waiting" ? { wait: { kind: "agent_messages" } } : {}),
        },
      });
      const prompt = "Inspect the current execution";

      expect(newestTaskSnapshot(stale, { ...fresh, prompt })).toEqual({ ...fresh, prompt });
      expect(newestTaskSnapshot(fresh, { ...stale, prompt })).toEqual({ ...fresh, prompt });
      expect(mergeTaskLists([fresh], [stale])).toEqual([fresh]);
      expect(mergeTaskLists([stale], [fresh])).toEqual([fresh]);
    },
  );

  it("keeps current terminal output when an equally current detail is stale", () => {
    const completed = task({
      id: "shared",
      status: "completed",
      updatedAt: 200,
      terminalSummary: "Audit complete",
      execution: { state: "finished", lastActivityAt: 300 },
    });
    const detail = task({
      id: "shared",
      status: "completed",
      updatedAt: 200,
      terminalSummary: "Stale running progress",
      prompt: "Inspect the concurrent task owner",
      execution: { state: "finished", lastActivityAt: 400 },
    });

    expect(newestTaskSnapshot(completed, detail)).toEqual(completed);
  });

  it("accepts a genuinely newer running snapshot from the active page", () => {
    const oldRunning = task({
      id: "shared",
      status: "running",
      updatedAt: 100,
      execution: { state: "running", lastActivityAt: 400 },
    });
    const newRunning = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      execution: { state: "waiting", lastActivityAt: 300 },
    });

    expect(mergeTaskLists([oldRunning], [newRunning])).toEqual([newRunning]);
    expect(mergeTaskLists([newRunning], [oldRunning])).toEqual([newRunning]);
  });

  it("normalizes cancel results including refusals with reasons", () => {
    expect(
      normalizeTasksCancelResult({
        found: true,
        cancelled: false,
        reason: "task already finished",
        task: { id: "task-1", taskId: "task-1", status: "completed" },
      }),
    ).toEqual({
      found: true,
      cancelled: false,
      reason: "task already finished",
      task: { id: "task-1", taskId: "task-1", status: "completed" },
    });
    expect(normalizeTasksCancelResult({ found: true, cancelled: true })).toEqual({
      found: true,
      cancelled: true,
    });
    expect(normalizeTasksCancelResult({ found: true })).toBeNull();
    expect(normalizeTasksCancelResult("nope")).toBeNull();
  });

  it("uses the protocol schema while preserving the required UI task id", () => {
    const wireTask = {
      id: " task-1 ",
      status: "running",
      runtime: "future-runtime",
      runId: "run-1",
      flowId: "flow-1",
      parentTaskId: "parent-1",
      sourceId: "source-1",
    };

    expect(normalizeTasksListResult({ tasks: [wireTask], nextCursor: "page-2" })).toEqual({
      nextCursor: "page-2",
      tasks: [
        {
          ...wireTask,
          id: "task-1",
          taskId: "task-1",
        },
      ],
    });
    expect(normalizeTasksGetResult({ task: wireTask })?.taskId).toBe("task-1");
    expect(normalizeTasksListResult({ tasks: [{ ...wireTask, updatedAt: false }] })).toBeNull();
    expect(normalizeTasksListResult({ tasks: [wireTask], nextCursor: 2 })).toBeNull();
    expect(normalizeTasksListResult({ tasks: "not-a-page" })).toBeNull();
  });
});

describe("coalesced task event replay", () => {
  const upsert = (overrides: Partial<TaskSummary>) => ({
    action: "upserted" as const,
    task: task({ id: "shared", status: "running", ...overrides }),
  });
  const remove = (taskId = "shared") => ({ action: "deleted" as const, taskId });

  it.each([
    {
      name: "newer and stale snapshots",
      initial: [],
      events: [upsert({ updatedAt: 100 }), upsert({ updatedAt: 300 }), upsert({ updatedAt: 200 })],
      expected: [task({ id: "shared", status: "running", updatedAt: 300 })],
    },
    {
      name: "newer snapshot remains authoritative",
      initial: [
        task({ id: "shared", status: "running", updatedAt: 400, prompt: "Retained detail" }),
      ],
      events: [upsert({ updatedAt: 100 }), upsert({ updatedAt: 300 })],
      expected: [
        task({ id: "shared", status: "running", updatedAt: 400, prompt: "Retained detail" }),
      ],
    },
    {
      name: "equal-time lifecycle and tool progress",
      initial: [
        task({ id: "shared", status: "queued", updatedAt: 200, prompt: "Retained detail" }),
      ],
      events: [
        upsert({ status: "queued", updatedAt: 200, toolUseCount: 1 }),
        upsert({ updatedAt: 200, toolUseCount: 5 }),
        upsert({ status: "queued", updatedAt: 200, toolUseCount: 9 }),
        upsert({ updatedAt: 200, toolUseCount: 2 }),
        upsert({ updatedAt: 200, toolUseCount: 6 }),
      ],
      expected: [
        task({
          id: "shared",
          status: "running",
          updatedAt: 200,
          toolUseCount: 6,
          prompt: "Retained detail",
        }),
      ],
    },
    {
      name: "terminal corrections and stale active progress",
      initial: [],
      events: [
        upsert({ updatedAt: 200 }),
        upsert({ status: "completed", updatedAt: 200, terminalSummary: "Done" }),
        upsert({ status: "failed", updatedAt: 200, terminalSummary: "Corrected failure" }),
        upsert({ updatedAt: 200, toolUseCount: 8 }),
        upsert({ status: "cancelled", updatedAt: 200, terminalSummary: "Final correction" }),
      ],
      expected: [
        task({
          id: "shared",
          status: "cancelled",
          updatedAt: 200,
          terminalSummary: "Final correction",
        }),
      ],
    },
    {
      name: "deletion followed by a lower-timestamp recreation",
      initial: [
        task({ id: "shared", status: "running", updatedAt: 400, prompt: "Discarded detail" }),
      ],
      events: [
        upsert({ updatedAt: 300, title: "Old incarnation" }),
        remove(),
        upsert({ updatedAt: 100, title: "Recreated task" }),
        upsert({ updatedAt: 110, title: "Recreated task progress" }),
      ],
      expected: [
        task({ id: "shared", status: "running", updatedAt: 110, title: "Recreated task progress" }),
      ],
    },
    {
      name: "repeated final deletion preserves unrelated tasks",
      initial: [task({ id: "untouched", status: "running", updatedAt: 200 })],
      events: [upsert({ updatedAt: 100 }), upsert({ updatedAt: 200 }), remove(), remove()],
      expected: [task({ id: "untouched", status: "running", updatedAt: 200 })],
    },
    {
      name: "interleaved independent task identities",
      initial: [],
      events: [
        upsert({ updatedAt: 100 }),
        upsert({ id: "other", updatedAt: 200 }),
        remove(),
        upsert({ id: "other", updatedAt: 150 }),
        upsert({ updatedAt: 100 }),
        remove("other"),
      ],
      expected: [task({ id: "shared", status: "running", updatedAt: 100 })],
    },
  ])("replays $name", ({ initial, events, expected }) => {
    const pending = new Map<string, CoalescedTaskEvent>();
    for (const event of events) {
      coalesceTaskEvent(pending, event);
    }
    expect(replayTaskEvents(initial, pending)).toEqual(expected);
    expect(pending.size).toBe(
      new Set(events.map((event) => (event.action === "deleted" ? event.taskId : event.task.id)))
        .size,
    );
  });

  it.each(["completed", "failed", "cancelled", "timed_out"] as const)(
    "keeps %s terminal output after stale running progress and accepts its correction",
    (status) => {
      const terminal = task({ id: "shared", status, updatedAt: 200, terminalSummary: "Done" });
      const pending = new Map<string, CoalescedTaskEvent>();
      coalesceTaskEvent(pending, upsert({ updatedAt: 200, toolUseCount: 8 }));
      expect(replayTaskEvents([terminal], pending)).toEqual([terminal]);
      coalesceTaskEvent(pending, upsert({ status, updatedAt: 200, terminalSummary: "Corrected" }));
      expect(replayTaskEvents([terminal], pending)).toEqual([
        { ...terminal, terminalSummary: "Corrected" },
      ]);
    },
  );
});
