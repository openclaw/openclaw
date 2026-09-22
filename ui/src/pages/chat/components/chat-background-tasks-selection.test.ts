import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../../test/helpers/promise.js";
import { createHost, flushAsync, makeTask } from "../../../test-helpers/chat-background-tasks.ts";
import { createBackgroundTasksProps, handleBackgroundTasksEvent } from "./chat-background-tasks.ts";
import { readTaskTranscript } from "./chat-task-detail-state.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("background tasks selection and detail state", () => {
  it("routes row selection to the task panel and loads its bounded prompt on demand", async () => {
    const running = makeTask({
      id: "task-1",
      taskId: "runtime-task-1",
      progressSummary: "Reading files",
    });
    const { host, request } = createHost({
      request: (method) =>
        method === "tasks.get"
          ? Promise.resolve({ task: { ...running, prompt: "Audit the background task UI" } })
          : Promise.resolve({ tasks: [running] }),
    });
    createBackgroundTasksProps(host);
    await flushAsync();

    const onOpenTaskDetail = vi.fn();
    const selected = createBackgroundTasksProps(host, {
      onOpenTaskDetail,
    });
    selected.onOpenTaskDetail?.(running);
    expect(onOpenTaskDetail).toHaveBeenCalledWith(running);
    expect(createBackgroundTasksProps(host, { selectedTaskId: running.id }).selectedTaskId).toBe(
      running.id,
    );
    // The controller consumes selection; it does not retain a second copy.
    expect(createBackgroundTasksProps(host).selectedTaskId).toBeUndefined();
    expect(request).not.toHaveBeenCalledWith("tasks.get", expect.anything());

    selected.onLoadDetail?.(running);
    await flushAsync();

    expect(request).toHaveBeenCalledWith("tasks.get", { taskId: "task-1" });
    const props = createBackgroundTasksProps(host);
    expect(props.taskDetails.get("task-1")?.prompt).toBe("Audit the background task UI");
  });

  it.each(["session", "agent", "client", "connection"] as const)(
    "retires scoped task data, transcript, and old callbacks when the %s owner changes",
    async (owner) => {
      const pending = deferred<{ messages: unknown[] }>();
      const { host } = createHost({
        request: (method) =>
          method === "tasks.history" ? pending.promise : Promise.resolve({ tasks: [] }),
      });
      host.sessionKey = "global";
      host.assistantAgentId = "main";
      host.connectionEpoch = 1;
      const task = makeTask({ id: "scoped-task", sessionKey: "global" });
      const onOpenTaskDetail = vi.fn();
      const onOpenTaskList = vi.fn();
      const previous = createBackgroundTasksProps(host, {
        presented: false,
        onOpenTaskDetail,
        onOpenTaskList,
      });
      previous.onOpenTaskDetail?.(task);
      readTaskTranscript(host, { taskId: task.id });
      expect(host.taskDetailState).toBeDefined();
      expect(
        createBackgroundTasksProps(host, { presented: false, selectedTaskId: task.id })
          .selectedTaskId,
      ).toBe(task.id);
      if (owner === "session") {
        host.sessionKey = "agent:main:replacement";
      } else if (owner === "agent") {
        host.assistantAgentId = "work";
      } else if (owner === "client") {
        host.client = createHost().host.client;
      } else {
        host.connectionEpoch += 1;
      }
      const current = createBackgroundTasksProps(host, { presented: false });
      expect(current.selectedTaskId).toBeUndefined();
      expect(host.taskDetailState).toBeUndefined();
      previous.onOpenTaskDetail?.(task);
      previous.onOpenTaskList?.();
      expect(onOpenTaskDetail).toHaveBeenCalledOnce();
      expect(onOpenTaskList).not.toHaveBeenCalled();
      pending.resolve({ messages: [{ role: "assistant", content: "Retired transcript" }] });
      await pending.promise;
      expect(host.taskDetailState).toBeUndefined();
      expect(createBackgroundTasksProps(host, { presented: false }).selectedTaskId).toBeUndefined();
    },
  );

  it("releases the previous transcript when selecting another task", async () => {
    const pending = deferred<{ messages: unknown[] }>();
    const { host } = createHost({ request: () => pending.promise });
    const props = createBackgroundTasksProps(host, {
      presented: false,
      onOpenTaskDetail: () => {},
    });
    props.onOpenTaskDetail?.(makeTask({ id: "first" }));
    readTaskTranscript(host, { taskId: "first" });
    props.onOpenTaskDetail?.(makeTask({ id: "second" }));
    expect(host.taskDetailState).toBeUndefined();
    expect(
      createBackgroundTasksProps(host, { presented: false, selectedTaskId: "second" })
        .selectedTaskId,
    ).toBe("second");
    expect(createBackgroundTasksProps(host, { presented: false }).selectedTaskId).toBeUndefined();
    pending.resolve({ messages: [{ role: "assistant", content: "First transcript" }] });
    await pending.promise;
    expect(host.taskDetailState).toBeUndefined();
  });

  it("lets reopening a task retry a failed detail lookup", async () => {
    const running = makeTask({ id: "task-1" });
    let failLookup = true;
    const { host, request } = createHost({
      request: (method) => {
        if (method !== "tasks.get") {
          return Promise.resolve({ tasks: [running] });
        }
        return failLookup
          ? Promise.reject(new Error("lookup blew up: OPENAI_API_KEY=sk-1234567890abcdef"))
          : Promise.resolve({ task: { ...running, prompt: "Recovered prompt" } });
      },
    });
    createBackgroundTasksProps(host);
    await flushAsync();

    createBackgroundTasksProps(host, { onOpenTaskDetail: () => {} }).onLoadDetail?.(running);
    await flushAsync();
    expect(createBackgroundTasksProps(host).taskDetailErrors.get("task-1")).toBe(
      "lookup blew up: OPENAI_API_KEY=sk-123...cdef",
    );

    // Selection clears the recorded error so the panel's render-driven load
    // (which must skip errored tasks to avoid a retry loop) can run again.
    failLookup = false;
    const reopened = createBackgroundTasksProps(host, { onOpenTaskDetail: () => {} });
    reopened.onOpenTaskDetail?.(running);
    const afterReopen = createBackgroundTasksProps(host, { onOpenTaskDetail: () => {} });
    expect(afterReopen.taskDetailErrors.has("task-1")).toBe(false);
    afterReopen.onLoadDetail?.(running);
    await flushAsync();

    expect(request).toHaveBeenCalledWith("tasks.get", { taskId: "task-1" });
    expect(createBackgroundTasksProps(host).taskDetails.get("task-1")?.prompt).toBe(
      "Recovered prompt",
    );
  });

  it("promotes a newer detail snapshot into the grouped task list", async () => {
    const running = makeTask({ id: "task-1", status: "running", updatedAt: 2_000 });
    const completed = makeTask({
      id: "task-1",
      status: "completed",
      updatedAt: 3_000,
      terminalSummary: "Finished in lookup",
      prompt: "Review the task",
    });
    const { host } = createHost({
      request: (method) =>
        method === "tasks.get"
          ? Promise.resolve({ task: completed })
          : Promise.resolve({ tasks: [running] }),
    });
    createBackgroundTasksProps(host);
    await flushAsync();

    createBackgroundTasksProps(host).onLoadDetail?.(running);
    await flushAsync();

    const props = createBackgroundTasksProps(host);
    expect(props.tasks?.map((task) => [task.id, task.status])).toEqual([["task-1", "completed"]]);
    expect(props.taskDetails.get("task-1")?.terminalSummary).toBe("Finished in lookup");
  });

  it.each(["running", "waiting"] as const)(
    "promotes fresh %s detail and ignores older execution events at the same lifecycle time",
    async (state) => {
      const running = makeTask({
        id: "task-1",
        toolUseCount: 2,
        execution: { state: state === "running" ? "waiting" : "running", lastActivityAt: 3_000 },
      });
      const detail = makeTask({
        ...running,
        prompt: "Inspect the current execution",
        execution: {
          state,
          lastActivityAt: 4_000,
          ...(state === "waiting" ? { wait: { kind: "agent_messages" } } : {}),
        },
      });
      const { host } = createHost({
        request: (method) =>
          method === "tasks.get"
            ? Promise.resolve({ task: detail })
            : Promise.resolve({ tasks: [running] }),
      });
      createBackgroundTasksProps(host);
      await flushAsync();
      createBackgroundTasksProps(host).onLoadDetail?.(running);
      await flushAsync();

      expect(createBackgroundTasksProps(host).tasks).toEqual([detail]);
      handleBackgroundTasksEvent(host, { action: "upserted", task: running });
      createBackgroundTasksProps(host).onRefresh();
      await flushAsync();

      const props = createBackgroundTasksProps(host);
      expect(props.tasks).toEqual([detail]);
      expect(props.taskDetails.get(running.id)).toEqual(detail);
      expect(props.subagentActivity.rows[0]?.execution).toEqual(detail.execution);
    },
  );

  it("keeps newer execution when an older detail response arrives at the same lifecycle time", async () => {
    const running = makeTask({
      id: "task-1",
      toolUseCount: 2,
      execution: { state: "running", lastActivityAt: 3_000 },
    });
    const waiting = makeTask({
      ...running,
      toolUseCount: 1,
      execution: {
        state: "waiting",
        lastActivityAt: 4_000,
        wait: { kind: "agent_messages" },
      },
    });
    const detail = deferred<unknown>();
    const { host } = createHost({
      request: (method) =>
        method === "tasks.get" ? detail.promise : Promise.resolve({ tasks: [running] }),
    });
    createBackgroundTasksProps(host);
    await flushAsync();
    createBackgroundTasksProps(host).onLoadDetail?.(running);
    handleBackgroundTasksEvent(host, { action: "upserted", task: waiting });
    detail.resolve({ task: { ...running, prompt: "Inspect the current execution" } });
    await flushAsync();

    const expected = { ...waiting, prompt: "Inspect the current execution" };
    const props = createBackgroundTasksProps(host);
    expect(props.tasks).toEqual([expected]);
    expect(props.taskDetails.get(running.id)).toEqual(expected);
  });

  it("does not replace a newer detail snapshot with a stale list refresh", async () => {
    const running = makeTask({ id: "task-1", status: "running", updatedAt: 2_000 });
    const completed = makeTask({
      id: "task-1",
      status: "completed",
      updatedAt: 3_000,
      terminalSummary: "Finished in lookup",
      prompt: "Review the task",
    });
    let listCall = 0;
    let resolveActive: ((value: unknown) => void) | undefined;
    let resolveRecent: ((value: unknown) => void) | undefined;
    const active = new Promise<unknown>((resolve) => {
      resolveActive = resolve;
    });
    const recent = new Promise<unknown>((resolve) => {
      resolveRecent = resolve;
    });
    const { host } = createHost({
      request: (method) => {
        if (method === "tasks.get") {
          return Promise.resolve({ task: completed });
        }
        listCall += 1;
        if (listCall <= 2) {
          return Promise.resolve({ tasks: [running] });
        }
        return listCall === 3 ? active : recent;
      },
    });
    createBackgroundTasksProps(host);
    await flushAsync();

    createBackgroundTasksProps(host).onRefresh();
    createBackgroundTasksProps(host).onLoadDetail?.(running);
    await flushAsync();
    resolveActive?.({ tasks: [running] });
    resolveRecent?.({ tasks: [running] });
    await flushAsync();

    const props = createBackgroundTasksProps(host);
    expect(props.tasks?.map((task) => [task.id, task.status])).toEqual([["task-1", "completed"]]);
    expect(props.taskDetails.get("task-1")).toMatchObject({
      status: "completed",
      prompt: "Review the task",
      terminalSummary: "Finished in lookup",
    });
  });

  it("does not resurrect a task deleted while its detail lookup is pending", async () => {
    const running = makeTask({ id: "task-1" });
    let resolveDetail: ((value: unknown) => void) | undefined;
    const detail = new Promise<unknown>((resolve) => {
      resolveDetail = resolve;
    });
    const { host } = createHost({
      request: (method) =>
        method === "tasks.get" ? detail : Promise.resolve({ tasks: [running] }),
    });
    createBackgroundTasksProps(host);
    await flushAsync();

    createBackgroundTasksProps(host).onLoadDetail?.(running);
    handleBackgroundTasksEvent(host, { action: "deleted", taskId: "task-1" });
    resolveDetail?.({ task: { ...running, prompt: "Deleted task prompt" } });
    await flushAsync();

    const props = createBackgroundTasksProps(host);
    expect(props.tasks).toEqual([]);
    expect(props.taskDetails.has("task-1")).toBe(false);
  });
});
