import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import type { ChatPageHost } from "../chat-state-host.ts";
import type { ChatProps } from "../chat-view.ts";
import { closeSlot, openSlot, type SidebarLayout } from "../sidebar-layout.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import { renderChatDetailSlot } from "./chat-detail-slot.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import * as taskDetailState from "./chat-task-detail-state.ts";
import {
  loadOlderTaskTranscript,
  readTaskDetailSnapshot,
  resetTaskDetail,
  observeTaskDetailEvent,
  readTaskTranscript,
  type TaskDetailHost,
} from "./chat-task-detail-state.ts";
import type { ChatTranscriptController } from "./chat-transcript-controller.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function history(text: string) {
  return {
    messages: [{ role: "assistant", content: [{ type: "text", text }] }],
    sessionId: "child-session",
    thinkingLevel: null,
  };
}

function hostWith(request: ReturnType<typeof vi.fn>): TaskDetailHost {
  return {
    sessionKey: "agent:main:main",
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    connectionEpoch: 4,
    requestUpdate: vi.fn(),
  };
}

function task(status: TaskSummary["status"]): TaskSummary {
  return {
    id: "task-1",
    taskId: "task-1",
    status,
    runtime: "subagent",
    agentId: "main",
    sessionKey: "agent:main:main",
    childSessionKey: "agent:main:subagent:child",
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

function backgroundTasks(selectedTask: TaskSummary): BackgroundTasksProps {
  return {
    sessionKey: "agent:main:main",
    statusRowId: "chat-tasks-status-test",
    collapsed: false,
    narrowLayout: false,
    connected: true,
    canCancel: false,
    loading: false,
    error: null,
    tasks: [selectedTask],
    activeCount: selectedTask.status === "queued" || selectedTask.status === "running" ? 1 : 0,
    subagentActivity: {
      rows: [],
      overflowWorking: 0,
      taskIds: new Set(),
      nextExpiryAt: null,
    },
    taskDetails: new Map(),
    taskDetailErrors: new Map(),
    taskDetailLoadingIds: new Set(),
    cancellingTaskIds: new Set(),
    finishedCollapsed: false,
    onToggleCollapsed: () => undefined,
    onToggleFinished: () => undefined,
    onRefresh: () => undefined,
    onCancel: () => undefined,
  };
}

const taskContent = { kind: "task", taskId: "task-1" } satisfies SidebarContent;
const fileContent = {
  kind: "file",
  path: "notes.txt",
  name: "notes.txt",
  content: "Non-task detail",
} satisfies SidebarContent;

function renderDetail(host: TaskDetailHost, content: SidebarContent, layout: SidebarLayout) {
  renderChatDetailSlot({
    backgroundTasks: backgroundTasks(task("running")),
    chat: { paneId: "pane-1" } as ChatProps,
    content,
    host: host as ChatPageHost,
    layout,
    transcript: {} as ChatTranscriptController,
  });
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("task detail transcript state", () => {
  it("clears transcript state when the detail slot closes", () => {
    const pending = deferred<never>();
    const host = hostWith(vi.fn().mockReturnValue(pending.promise));
    const openDetailLayout = openSlot({ columns: [] }, "detail");

    renderDetail(host, taskContent, openDetailLayout);
    expect(host.taskDetailState).toBeDefined();

    renderDetail(host, taskContent, closeSlot(openDetailLayout, "detail"));
    expect(host.taskDetailState).toBeUndefined();
  });

  it("does not reset transcript state during stable task or non-task renders", () => {
    const pending = deferred<never>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const host = hostWith(request);
    const openDetailLayout = openSlot({ columns: [] }, "detail");
    const reset = vi.spyOn(taskDetailState, "resetTaskDetail");

    renderDetail(host, taskContent, openDetailLayout);
    const openTaskState = host.taskDetailState;
    renderDetail(host, taskContent, openDetailLayout);

    expect(host.taskDetailState).toBe(openTaskState);
    expect(request).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();

    renderDetail(host, fileContent, openDetailLayout);
    expect(host.taskDetailState).toBeUndefined();
    expect(reset).toHaveBeenCalledOnce();

    renderDetail(host, fileContent, openDetailLayout);
    expect(reset).toHaveBeenCalledOnce();
  });

  it("loads the selected child transcript", async () => {
    const pending = deferred<ReturnType<typeof history>>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const host = hostWith(request);

    expect(
      readTaskTranscript(host, {
        taskId: "task-1",
        sessionKey: "agent:main:subagent:child",
      }),
    ).toEqual({ status: "loading" });
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "agent:main:subagent:child",
      limit: 800,
    });

    pending.resolve(history("Child transcript loaded."));
    await flushAsync();
    expect(
      readTaskTranscript(host, {
        taskId: "task-1",
        sessionKey: "agent:main:subagent:child",
      }),
    ).toMatchObject({
      status: "loaded",
      messages: [{ role: "assistant" }],
    });
  });

  it("surfaces a history request failure", async () => {
    const pending = deferred<never>();
    const host = hostWith(vi.fn().mockReturnValue(pending.promise));
    readTaskTranscript(host, {
      taskId: "task-1",
      sessionKey: "agent:main:subagent:child",
    });

    pending.reject(new Error("history unavailable"));
    await flushAsync();
    expect(
      readTaskTranscript(host, {
        taskId: "task-1",
        sessionKey: "agent:main:subagent:child",
      }),
    ).toEqual({ status: "error" });
  });

  it("coalesces in-flight events and performs the terminal refresh after the throttle", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(10_000);
    const first = deferred<ReturnType<typeof history>>();
    const final = deferred<ReturnType<typeof history>>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(final.promise);
    const host = hostWith(request);
    readTaskTranscript(host, {
      taskId: "task-1",
      sessionKey: "agent:main:subagent:child",
    });

    observeTaskDetailEvent(host, { action: "upserted", task: task("running") });
    observeTaskDetailEvent(host, { action: "upserted", task: task("completed") });
    expect(request).toHaveBeenCalledTimes(1);

    first.resolve(history("Still running."));
    await flushAsync();
    vi.advanceTimersByTime(1_999);
    expect(request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(request).toHaveBeenCalledTimes(2);

    final.resolve(history("Final child response."));
    await flushAsync();
    expect(
      readTaskTranscript(host, {
        taskId: "task-1",
        sessionKey: "agent:main:subagent:child",
      }),
    ).toMatchObject({ status: "loaded" });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("native task inspection", () => {
  const selection = { taskId: "task-1", native: true as const, active: true };
  const item = (id: string, text = id) => ({ id, type: "agentMessage" as const, text });
  const nativeTask = (status: TaskSummary["status"], id = "task-1") => ({
    ...task(status),
    id,
    taskId: id,
    childSessionKey: undefined,
    transcriptAvailable: true,
  });

  it("keeps reading child work without parent events and stops after terminal history", async () => {
    vi.useFakeTimers();
    let status: TaskSummary["status"] = "running";
    let snapshot = "First child output";
    const earlierOutput = snapshot;
    const request = vi.fn(async (method: string, params?: { cursor?: string }) =>
      method === "tasks.get"
        ? { task: nativeTask(status) }
        : params?.cursor
          ? { taskId: "task-1", items: [item("older-message", earlierOutput)] }
          : { taskId: "task-1", items: [item("message", snapshot)], nextCursor: "older" },
    );
    const host = hostWith(request);
    readTaskTranscript(host, selection);
    await vi.advanceTimersByTimeAsync(0);
    expect(readTaskTranscript(host, selection)).toMatchObject({
      status: "loaded",
      messages: [{ content: [{ text: snapshot }] }],
    });

    loadOlderTaskTranscript(host);
    await vi.advanceTimersByTimeAsync(0);
    // Separate source events may have identical text; refresh must preserve both.
    expect(readTaskTranscript(host, selection)).toMatchObject({
      messages: [{ messageId: "older-message" }, { messageId: "message" }],
    });

    snapshot = "Child progressed after parent yielded";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(readTaskTranscript(host, selection)).toMatchObject({
      messages: [
        { messageId: "older-message", content: [{ text: earlierOutput }] },
        { messageId: "message", content: [{ text: snapshot }] },
      ],
    });
    status = "completed";
    snapshot = "Final child output";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(readTaskTranscript(host, selection)).toMatchObject({
      messages: [
        { messageId: "older-message", content: [{ text: earlierOutput }] },
        { messageId: "message", content: [{ text: snapshot }] },
      ],
    });
    const completedCalls = request.mock.calls.length;
    expect(readTaskDetailSnapshot(host, nativeTask("running")).status).toBe("completed");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(request).toHaveBeenCalledTimes(completedCalls);
    expect(
      request.mock.calls.every(([method]) => method === "tasks.get" || method === "tasks.history"),
    ).toBe(true);
    resetTaskDetail(host);
  });

  it("loads past an empty first page, deduplicates overlap, and excludes reasoning", async () => {
    const pages = [
      { taskId: "task-1", items: [], nextCursor: "older-1" },
      { taskId: "task-1", items: [item("new"), item("old")], nextCursor: "older-2" },
      {
        taskId: "task-1",
        items: [item("old"), { id: "private", type: "reasoning", text: "hidden" }, item("oldest")],
      },
    ];
    const request = vi.fn(async (method: string) =>
      method === "tasks.get" ? { task: nativeTask("completed") } : pages.shift(),
    );
    const host = hostWith(request);
    readTaskTranscript(host, selection);
    await flushAsync();
    expect(readTaskTranscript(host, selection)).toMatchObject({
      status: "loaded",
      messages: [],
      nextCursor: "older-1",
    });
    loadOlderTaskTranscript(host);
    await flushAsync();
    expect(request).toHaveBeenCalledWith("tasks.history", {
      taskId: "task-1",
      limit: 100,
      cursor: "older-1",
    });
    loadOlderTaskTranscript(host);
    await flushAsync();
    expect(readTaskTranscript(host, selection)).toMatchObject({
      status: "loaded",
      messages: [{ messageId: "oldest" }, { messageId: "old" }, { messageId: "new" }],
    });
    expect(readTaskTranscript(host, selection)).not.toHaveProperty("nextCursor");
    resetTaskDetail(host);
  });

  it.each(["tasks.get", "tasks.history"])(
    "recovers after a transient %s failure without parent events",
    async (failingMethod) => {
      vi.useFakeTimers();
      let unavailable = true;
      const request = vi.fn(async (method: string) => {
        if (unavailable && method === failingMethod) {
          throw new Error("Temporarily unavailable");
        }
        return method === "tasks.get"
          ? { task: nativeTask(unavailable ? "running" : "completed") }
          : { taskId: "task-1", items: [item("final", "Recovered child output")] };
      });
      const host = hostWith(request);
      readTaskTranscript(host, selection);
      await vi.advanceTimersByTimeAsync(0);
      expect(readTaskTranscript(host, selection)).toEqual({ status: "error" });
      const failedCalls = request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(request).toHaveBeenCalledTimes(failedCalls);

      unavailable = false;
      await vi.advanceTimersByTimeAsync(1);
      expect(readTaskTranscript(host, selection)).toMatchObject({
        status: "loaded",
        messages: [{ content: [{ text: "Recovered child output" }] }],
      });
      expect(readTaskDetailSnapshot(host, nativeTask("running")).status).toBe("completed");
      const settledCalls = request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(request).toHaveBeenCalledTimes(settledCalls);
      resetTaskDetail(host);
    },
  );

  it.each(["selection", "close", "disconnect", "epoch"] as const)(
    "ignores late native history after %s changes",
    async (change) => {
      const pending = deferred<unknown>();
      const request = vi.fn(async (method: string, params: { taskId: string }) => {
        if (method === "tasks.get") {
          return { task: nativeTask("completed", params.taskId) };
        }
        return params.taskId === "task-1"
          ? pending.promise
          : { taskId: params.taskId, items: [item("new-selection")] };
      });
      const host = hostWith(request);
      readTaskTranscript(host, selection);
      await flushAsync();
      if (change === "selection") {
        readTaskTranscript(host, { ...selection, taskId: "task-2" });
      }
      if (change === "close") {
        resetTaskDetail(host);
      }
      if (change === "disconnect") {
        host.connected = false;
      }
      if (change === "epoch") {
        host.connectionEpoch = 5;
      }
      await flushAsync();
      const update = host.requestUpdate as ReturnType<typeof vi.fn>;
      update.mockClear();
      pending.resolve({ taskId: "task-1", items: [item("stale-output")] });
      await flushAsync();
      expect(update).not.toHaveBeenCalled();
      expect(JSON.stringify(host.taskDetailState?.load ?? null)).not.toContain("stale-output");
      if (change === "selection") {
        expect(host.taskDetailState?.load).toMatchObject({
          status: "loaded",
          messages: [{ messageId: "new-selection" }],
        });
      }
      if (change === "close") {
        expect(host.taskDetailState).toBeUndefined();
      }
      resetTaskDetail(host);
    },
  );
});
