import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { createGatewayBrowserClientFixture } from "../chat-pane.test-support.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import type { SidebarFullMessageLoader } from "./chat-sidebar-content-types.ts";
import { deriveSubagentActivity } from "./chat-subagent-activity.ts";
import type { TaskDetailHost } from "./chat-task-detail-state.ts";
import { renderTaskDetailPanel } from "./chat-task-detail.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

function backgroundTasks(task: TaskSummary): BackgroundTasksProps {
  return {
    sessionKey: "agent:main:main",
    statusRowId: "chat-tasks-status-test",
    collapsed: false,
    narrowLayout: false,
    connected: true,
    canCancel: false,
    loading: false,
    error: null,
    tasks: [task],
    activeCount: task.status === "queued" || task.status === "running" ? 1 : 0,
    subagentActivity: deriveSubagentActivity({
      tasks: [],
      sessionKey: "agent:main:main",
      terminalObservedAtByTask: new Map(),
      canonicalizeSessionKey: (sessionKey) => sessionKey ?? "",
    }),
    taskDetails: new Map([[task.id, { ...task, prompt: "Inspect the current task." }]]),
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

beforeEach(installTranscriptDomMocks);

afterEach(resetTranscriptTestDom);

describe("task detail panel", () => {
  it.each(["task", "connection"])(
    "ignores a pending full reply after the %s changes",
    async (change) => {
      const task: TaskSummary = {
        id: "first-task",
        taskId: "first-task",
        status: "completed",
        runtime: "subagent",
        agentId: "worker",
        childSessionKey: "agent:worker:subagent:first",
        title: "Child work",
      };
      const pending = createDeferred<Awaited<ReturnType<SidebarFullMessageLoader>>>();
      const loader = vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue({
          ok: true,
          message: { role: "assistant", content: "Current complete reply." },
        });
      const host: TaskDetailHost = {
        sessionKey: "agent:main:main",
        connected: true,
        hello: null,
        connectionEpoch: 1,
        client: createGatewayBrowserClientFixture({
          request: vi.fn().mockResolvedValue({
            messages: [
              { role: "assistant", content: "Preview", __openclaw: { id: "m-1", truncated: true } },
            ],
          }),
        }),
      };
      const container = document.body.appendChild(document.createElement("div"));
      const rerender = (selected: TaskSummary) =>
        render(
          renderTaskDetailPanel({
            backgroundTasks: backgroundTasks(selected),
            host,
            task: selected,
            loadFullAssistantMessage: loader,
          }),
          container,
        );
      rerender(task);
      await vi.waitFor(() => expect(host.taskDetailState?.load.status).toBe("loaded"));
      rerender(task);
      expect(loader).toHaveBeenCalledTimes(1);
      const oldState = host.taskDetailState!;
      const next =
        change === "task"
          ? {
              ...task,
              id: "second-task",
              taskId: "second-task",
              childSessionKey: "agent:worker:subagent:second",
            }
          : task;
      if (change === "connection") {
        host.connectionEpoch = 2;
      }
      rerender(next);
      expect(oldState.fullMessages.size).toBe(0);
      await vi.waitFor(() => expect(host.taskDetailState?.load.status).toBe("loaded"));
      rerender(next);
      await vi.waitFor(() =>
        expect(host.taskDetailState?.fullMessages.get("m-1")?.status).toBe("loaded"),
      );
      pending.resolve({
        ok: true,
        message: { role: "assistant", content: "Stale complete reply." },
      });
      await pending.promise;
      rerender(next);
      expect(container.textContent).toContain("Current complete reply.");
      expect(container.textContent).not.toContain("Stale complete reply.");
      expect(oldState.fullMessages.size).toBe(0);
    },
  );

  it("keeps a capped task-only transcript preview when no child session exists", async () => {
    const task: TaskSummary = {
      id: "task-native",
      taskId: "task-native",
      status: "completed",
      runtime: "subagent",
      agentId: "main",
      hasTranscript: true,
      sessionKey: "agent:main:main",
      title: "Native task",
    };
    const host: TaskDetailHost = {
      sessionKey: "agent:main:main",
      connected: true,
      hello: null,
      client: createGatewayBrowserClientFixture({
        request: vi.fn().mockResolvedValue({
          messages: [
            {
              role: "assistant",
              content: "Runtime preview",
              __openclaw: { id: "m-1", truncated: true },
            },
          ],
        }),
      }),
    };
    const loader = vi.fn();
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () =>
      render(
        renderTaskDetailPanel({
          backgroundTasks: backgroundTasks(task),
          host,
          task,
          loadFullAssistantMessage: loader,
        }),
        container,
      );
    rerender();
    await vi.waitFor(() => expect(host.taskDetailState?.load.status).toBe("loaded"));
    rerender();
    expect(container.textContent).toContain("Runtime preview");
    expect(loader).not.toHaveBeenCalled();
  });

  it("recovers capped replies from the child session and clears them when switching tasks", async () => {
    const task: TaskSummary = {
      id: "task-capped",
      taskId: "task-capped",
      status: "completed",
      runtime: "subagent",
      agentId: "worker",
      childSessionKey: "agent:worker:subagent:child",
      sessionKey: "agent:main:main",
      title: "Capped reply",
    };
    const request = vi.fn().mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: "Capped preview",
          __openclaw: { id: "m-1", truncated: true, reason: "display-cap" },
        },
      ],
    });
    const loader = vi.fn().mockResolvedValue({
      ok: true,
      message: { role: "assistant", content: "The **complete** reply." },
    });
    const host: TaskDetailHost = {
      sessionKey: "agent:main:main",
      client: createGatewayBrowserClientFixture({ request }),
      connected: true,
      hello: null,
      requestUpdate: vi.fn(),
    };
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = (selected = task) =>
      render(
        renderTaskDetailPanel({
          backgroundTasks: backgroundTasks(selected),
          host,
          task: selected,
          loadFullAssistantMessage: loader,
        }),
        container,
      );
    rerender();
    await vi.waitFor(() => expect(host.taskDetailState?.load.status).toBe("loaded"));
    rerender();
    expect(loader).toHaveBeenCalledExactlyOnceWith({
      sessionKey: task.childSessionKey,
      agentId: "worker",
      messageId: "m-1",
    });
    await vi.waitFor(() =>
      expect(host.taskDetailState?.fullMessages.get("m-1")?.status).toBe("loaded"),
    );
    rerender();
    expect(container.querySelector("strong")?.textContent).toBe("complete");
    expect(container.textContent).not.toContain("Capped preview");
    const previous = host.taskDetailState!;
    rerender({ ...task, id: "other-task", taskId: "other-task" });
    expect(previous.fullMessages.size).toBe(0);
    expect(host.taskDetailState?.fullMessages.size).toBe(0);
  });

  it("uses the inspector for the pane's canonical session and identifies the runtime", () => {
    const task: TaskSummary = {
      id: "task-cli",
      taskId: "task-cli",
      status: "completed",
      runtime: "cli",
      agentId: "main",
      title: "Current-session command",
      hasTranscript: true,
      sessionKey: "agent:main:main",
      terminalSummary: "Command complete",
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const request = vi.fn();
    const host: TaskDetailHost = {
      sessionKey: "main",
      client: createGatewayBrowserClientFixture({ request }),
      connected: true,
      hello: {
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "agent:main:main",
            scope: "per-sender",
          },
        },
      },
    };
    const container = document.createElement("div");
    document.body.append(container);

    render(
      html`${renderTaskDetailPanel({
        backgroundTasks: backgroundTasks(task),
        host,
        task,
      })}`,
      container,
    );

    const panel = container.querySelector("[data-task-detail-panel]");
    expect(panel?.textContent).toContain("Current-session command");
    expect(panel?.textContent).toContain("CLI");
    expect(panel?.textContent).toContain("Inspect the current task.");
    expect(panel?.textContent).toContain("Command complete");
    expect(panel?.textContent).not.toContain("Loading task transcript");
    expect(request).not.toHaveBeenCalled();
  });

  it("never treats a subagent's requester session as its transcript", () => {
    const task: TaskSummary = {
      id: "task-queued-subagent",
      taskId: "task-queued-subagent",
      status: "queued",
      runtime: "subagent",
      agentId: "main",
      title: "Queued child work",
      // Requester is another conversation; no child session exists yet.
      sessionKey: "agent:main:other-session",
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const request = vi.fn();
    const host: TaskDetailHost = {
      sessionKey: "main",
      client: createGatewayBrowserClientFixture({ request }),
      connected: true,
      hello: null,
    };
    const container = document.createElement("div");
    document.body.append(container);

    render(
      html`${renderTaskDetailPanel({
        backgroundTasks: backgroundTasks(task),
        host,
        task,
      })}`,
      container,
    );

    const panel = container.querySelector("[data-task-detail-panel]");
    expect(panel?.textContent).toContain("Inspect the current task.");
    expect(panel?.textContent).not.toContain("Loading task transcript");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { name: "native subagent", hasTranscript: true },
    { name: "child session", childSessionKey: "agent:main:subagent:child" },
  ])("renders and pages the $name transcript through the task API", async (source) => {
    const task: TaskSummary = {
      id: "task-child",
      taskId: "task-child",
      status: "completed",
      runtime: "subagent",
      agentId: "main",
      title: "Investigate rendering",
      sessionKey: "agent:main:main",
      ...source,
    };
    const currentMessage = {
      role: "assistant",
      messageId: "answer",
      content: "The rendering issue is fixed.",
    };
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("history unavailable"))
      .mockResolvedValueOnce({ messages: [currentMessage], nextCursor: "previous-page" })
      .mockResolvedValueOnce({
        messages: [
          { role: "user", messageId: "prompt", content: "Inspect the renderer." },
          currentMessage,
        ],
      });
    const host: TaskDetailHost = {
      sessionKey: "agent:main:main",
      client: createGatewayBrowserClientFixture({ request }),
      connected: true,
      hello: null,
    };
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () => {
      render(
        html`${renderTaskDetailPanel({
          backgroundTasks: backgroundTasks(task),
          host,
          task,
        })}`,
        container,
      );
    };
    const button = (label: string) =>
      Array.from(container.querySelectorAll("button")).find((element) =>
        element.textContent?.includes(label),
      );
    rerender();
    await vi.waitFor(() => expect(host.taskDetailState?.load.status).toBe("error"));
    rerender();
    expect(button("Retry")).toBeDefined();
    button("Retry")?.click();
    await vi.waitFor(() => expect(host.taskDetailState?.load.status).toBe("loaded"));
    rerender();

    expect(container.textContent).toContain("The rendering issue is fixed.");
    expect(container.textContent).not.toContain("Inspect the current task.");
    expect(request).toHaveBeenLastCalledWith("tasks.history", { taskId: task.id, limit: 100 });
    expect(button("Show earlier")).toBeDefined();
    button("Show earlier")?.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(host.taskDetailState?.load).toMatchObject({
        status: "loaded",
        loading: false,
        nextCursor: undefined,
      }),
    );
    rerender();

    expect(request).toHaveBeenLastCalledWith("tasks.history", {
      taskId: task.id,
      limit: 100,
      cursor: "previous-page",
    });
    expect(container.textContent).toContain("Inspect the renderer.");
    expect(container.textContent?.split("The rendering issue is fixed.")).toHaveLength(2);
    expect(button("Show earlier")).toBeUndefined();
  });
});

describe("task activity monitor", () => {
  const task: TaskSummary = {
    id: "task-monitor",
    taskId: "task-monitor",
    agentId: "main",
    status: "running",
    runtime: "subagent",
    hasTranscript: true,
    startedAt: 1_000,
  };

  async function mount(current: TaskSummary, props = backgroundTasks(current)) {
    const host: TaskDetailHost = {
      sessionKey: "agent:main:main",
      client: createGatewayBrowserClientFixture({
        request: vi.fn().mockResolvedValue({
          messages: [{ role: "assistant", content: "Inspecting the implementation." }],
        }),
      }),
      connected: true,
      hello: null,
    };
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () =>
      render(renderTaskDetailPanel({ backgroundTasks: props, host, task: current }), container);
    rerender();
    await vi.waitFor(() => expect(host.taskDetailState?.load.status).toBe("loaded"));
    rerender();
    return { container, rerender };
  }

  it.each([
    {
      title: "Explicit title",
      kind: undefined,
      prompt: "Prompt title",
      progress: "Working",
      expected: "Explicit title",
    },
    {
      title: undefined,
      kind: "Named task kind",
      prompt: "Prompt title",
      progress: "Working",
      expected: "Named task kind",
    },
    {
      title: undefined,
      kind: undefined,
      prompt: "\n  Inspect the renderer  \nAdditional instructions",
      progress: "Working",
      expected: "Inspect the renderer",
    },
    {
      title: undefined,
      kind: undefined,
      prompt: undefined,
      progress: "Mapping the renderer",
      expected: "Mapping the renderer",
    },
    {
      title: undefined,
      kind: undefined,
      prompt: undefined,
      progress: undefined,
      expected: "Subagent",
    },
  ])(
    "derives the monitor title as $expected",
    async ({ title, kind, prompt, progress, expected }) => {
      const current = { ...task, title, kind, progressSummary: progress };
      const props = backgroundTasks(current);
      props.taskDetails = new Map([[task.id, { ...current, prompt }]]);
      const { container } = await mount(current, props);
      expect(container.querySelector(".sidebar-title")?.textContent).toBe(expected);
    },
  );

  it("bounds a prompt-derived title to a single compact line", async () => {
    const props = backgroundTasks(task);
    props.taskDetails = new Map([
      [task.id, { ...task, prompt: `  ${"a".repeat(160)}\nSecond line` }],
    ]);
    const { container } = await mount(task, props);
    const title = container.querySelector(".sidebar-title")?.textContent ?? "";
    expect(title).toMatch(/^a+…$/);
    expect(title.length).toBeLessThanOrEqual(121);
    expect(title.length).toBeGreaterThanOrEqual(119);
  });

  it("loads missing prompt detail once while showing progress as the title", async () => {
    const current = { ...task, progressSummary: "Checking the task feed" };
    const props = backgroundTasks(current);
    const loadingIds = new Set<string>();
    props.taskDetails = new Map();
    props.taskDetailLoadingIds = loadingIds;
    props.onLoadDetail = vi.fn((selected) => {
      loadingIds.add(selected.id);
    });
    const { container, rerender } = await mount(current, props);
    rerender();
    expect(props.onLoadDetail).toHaveBeenCalledExactlyOnceWith(current);
    expect(container.querySelector(".sidebar-title")?.textContent).toBe("Checking the task feed");
    props.taskDetails = new Map([[task.id, { ...current, prompt: "Inspect rendering contracts" }]]);
    rerender();
    expect(container.querySelector(".sidebar-title")?.textContent).toBe(
      "Inspect rendering contracts",
    );
  });

  it.each([
    {
      status: "running",
      progressSummary: "Reading the renderer",
      terminalSummary: "Stale result",
      error: undefined,
      label: "Now",
      text: "Reading the renderer",
      danger: false,
    },
    {
      status: "completed",
      progressSummary: "Stale progress",
      terminalSummary: "Rendering is fixed",
      error: undefined,
      label: "Completed",
      text: "Rendering is fixed",
      danger: false,
    },
    {
      status: "failed",
      progressSummary: "Stale progress",
      terminalSummary: "Partial work saved",
      error: "Command failed",
      label: "Failed",
      text: "Partial work saved",
      danger: false,
    },
    {
      status: "failed",
      progressSummary: "Stale progress",
      terminalSummary: undefined,
      error: "Command failed",
      label: "Failed",
      text: "Command failed",
      danger: true,
    },
    {
      status: "completed",
      progressSummary: "Stale progress",
      terminalSummary: undefined,
      error: undefined,
      label: undefined,
      text: undefined,
      danger: false,
    },
  ] as const)("shows the $status Now strip from the current summary: $text", async (entry) => {
    const { container } = await mount({ ...task, ...entry });
    const strip = container.querySelector(".chat-task-feed__now");
    if (!entry.text) {
      expect(strip).toBeNull();
      return;
    }
    expect(strip?.textContent).toContain(entry.label);
    expect(strip?.textContent).toContain(entry.text);
    expect(strip?.textContent).not.toContain("Stale");
    expect(strip?.classList.contains("chat-task-feed__error")).toBe(entry.danger);
    expect(strip?.parentElement).toBe(container.querySelector(".chat-task-detail__content"));
  });

  it.each([1, 3])(
    "shows active status, elapsed time, %s tool calls and latest tool without repeating Subagent",
    async (toolUseCount) => {
      const current = { ...task, title: "Inspect renderer", toolUseCount, lastToolName: "read" };
      const props = backgroundTasks(current);
      props.canCancel = true;
      props.onCancel = vi.fn();
      const { container } = await mount(current, props);
      const header = container.querySelector(".chat-task-detail__header");
      const meta = header?.querySelector(".chat-task-detail__meta");
      expect(meta?.textContent).toContain("Running");
      expect(meta?.textContent).toContain(
        `${toolUseCount} tool call${toolUseCount === 1 ? "" : "s"}`,
      );
      expect(meta?.textContent).toContain("read");
      expect(meta?.textContent).not.toContain("Subagent");
      expect(meta?.querySelector(".chat-tasks-rail__task-pulse")).not.toBeNull();
      expect(meta?.querySelector("openclaw-elapsed-time")).not.toBeNull();
      header
        ?.querySelector<HTMLButtonElement>('button[aria-label="Stop Inspect renderer"]')
        ?.click();
      expect(props.onCancel).toHaveBeenCalledWith(task.id);
    },
  );

  it("shows a finished duration and diff stats without the previous tool", async () => {
    const { container } = await mount({
      ...task,
      title: "Inspect renderer",
      status: "completed",
      endedAt: 66_000,
      lastToolName: "stale-tool",
      diffStat: { files: 1, added: 4, removed: 2 },
    });
    const meta = container.querySelector(".chat-task-detail__meta");
    expect(meta?.textContent).toContain("1m 5s");
    expect(meta?.textContent).toContain("+4");
    expect(meta?.textContent).toContain("-2");
    expect(meta?.textContent).not.toContain("stale-tool");
    expect(meta?.querySelector("openclaw-elapsed-time")).toBeNull();
  });
});
