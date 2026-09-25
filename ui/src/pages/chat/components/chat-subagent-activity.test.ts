import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { renderBackgroundTasksStatusRow } from "./chat-background-tasks-status.ts";
import {
  createBackgroundTasksProps,
  handleBackgroundTasksEvent,
  type BackgroundTasksHost,
} from "./chat-background-tasks.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import { deriveSubagentActivity } from "./chat-subagent-activity.ts";

function makeTask(overrides: Partial<TaskSummary> & { id: string }): TaskSummary {
  return {
    taskId: overrides.id,
    status: "running",
    runtime: "subagent",
    agentId: "main",
    title: "Map codebase",
    sessionKey: "agent:main:current",
    createdAt: 1_000,
    updatedAt: 2_000,
    startedAt: 1_500,
    ...overrides,
  };
}

function makeProps(overrides: Partial<BackgroundTasksProps>): BackgroundTasksProps {
  return {
    sessionKey: "agent:main:current",
    statusRowId: "chat-tasks-status-test",
    collapsed: true,
    narrowLayout: false,
    connected: true,
    canCancel: false,
    loading: false,
    error: null,
    tasks: [],
    activeCount: 0,
    subagentActivity: deriveSubagentActivity({
      tasks: [],
      sessionKey: "agent:main:current",
      canonicalizeSessionKey: (sessionKey) => sessionKey ?? "",
    }),
    cancellingTaskIds: new Set(),
    finishedCollapsed: false,
    taskDetails: new Map(),
    taskDetailErrors: new Map(),
    taskDetailLoadingIds: new Set(),
    onToggleCollapsed: () => {},
    onToggleFinished: () => {},
    onRefresh: () => {},
    onCancel: () => {},
    onOpenTaskDetail: undefined,
    ...overrides,
  };
}

function renderStatusRow(overrides: Partial<BackgroundTasksProps>) {
  const container = document.createElement("div");
  document.body.append(container);
  render(html`${renderBackgroundTasksStatusRow(makeProps(overrides))}`, container);
  return container;
}

function createHost(...tasks: TaskSummary[]) {
  const requestUpdate = vi.fn();
  const request = vi.fn(() => Promise.resolve({ tasks }));
  const host: BackgroundTasksHost = {
    sessionKey: "agent:main:current",
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    hello: null,
    requestUpdate,
  };
  return { host, requestUpdate };
}

function flushAsync() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("subagent activity rows", () => {
  it.each([
    {
      lastActivity: "**Evidence limits:** original regression",
      expected: "Evidence limits: original regression",
    },
    { lastActivity: "**Block", expected: "Block" },
    {
      progressSummary: "All runs bind `abc123`, **not final** qualification",
      expected: "All runs bind abc123, not final qualification",
    },
    { lastToolName: "read_file", expected: "Last tool: read_file" },
    { lastActivity: "Inspecting items[0", expected: "Inspecting items[0" },
    {
      lastActivity: "Checking foo_bar_baz at ~/.openclaw: 1 < 2 and ~5 files",
      expected: "Checking foo_bar_baz at ~/.openclaw: 1 < 2 and ~5 files",
    },
  ])("shows readable preview text for $expected", ({ expected, ...overrides }) => {
    const task = makeTask({ id: "markdown-subagent", ...overrides });
    const container = renderStatusRow({
      tasks: [task],
      subagentActivity: deriveSubagentActivity({
        tasks: [task],
        sessionKey: "agent:main:current",
        canonicalizeSessionKey: (sessionKey) => sessionKey ?? "",
      }),
    });

    const snippet = container.querySelector(".chat-subagent-activity__snippet");
    expect(snippet?.textContent).toBe(expected);
    expect(container.querySelector("openclaw-tooltip")?.content).toContain(expected);
    expect(snippet?.childElementCount).toBe(0);
  });

  it.each([
    {
      title: "Continued review",
      label: "Continued review",
      runtime: "cli" as const,
      childSessionKey: "agent:main:subagent:review",
      status: "running" as const,
      description: "Running",
      moving: true,
    },
    {
      title: "  Layout review  ",
      label: "Layout review",
      status: "running" as const,
      description: "Running",
      moving: true,
    },
    {
      title: "",
      label: "Subagent",
      status: "running" as const,
      description: "Running",
      moving: true,
    },
    {
      title: undefined,
      label: "Subagent",
      status: "running" as const,
      description: "Running",
      moving: true,
    },
    {
      title: "Layout review",
      label: "Layout review",
      status: "queued" as const,
      description: "Queued",
    },
    {
      title: "Layout review",
      label: "Layout review",
      status: "running" as const,
      execution: { state: "waiting" as const },
      description: "Waiting",
    },
    {
      title: "Layout review",
      label: "Layout review",
      status: "running" as const,
      execution: { state: "unknown" as const },
      description: "Activity unknown",
    },
    {
      title: "Layout review",
      label: "Layout review",
      status: "running" as const,
      execution: { state: "queued" as const },
      description: "Queued",
    },
  ])(
    "opens $label activity with $description",
    ({ label, description, moving = false, ...taskProps }) => {
      const task = makeTask({
        id: "clickable-subagent",
        ...taskProps,
        lastActivity: "Checking spacing",
        terminalSummary: "Checking spacing",
      });
      const onOpenTaskDetail = vi.fn();
      const container = renderStatusRow({
        tasks: [task],
        subagentActivity: deriveSubagentActivity({
          tasks: [task],
          sessionKey: "agent:main:current",
          canonicalizeSessionKey: (sessionKey) => sessionKey ?? "",
        }),
        onOpenTaskDetail,
      });

      const row = container.querySelector<HTMLButtonElement>(
        '[data-subagent-task-id="clickable-subagent"]',
      );
      expect(row?.tagName).toBe("BUTTON");
      expect(row?.querySelector(".chat-subagent-activity__label")?.textContent).toBe(label);
      expect(row?.textContent?.replace(/\s+/g, " ").trim()).toBe(`${label} Checking spacing`);
      expect(row?.querySelector(".chat-reading-indicator") !== null).toBe(moving);
      expect(container.querySelector("openclaw-tooltip")?.content).toBe(
        `${label}\n${description}\nChecking spacing`,
      );
      expect(row?.querySelector(".chat-subagent-activity__snippet")?.textContent).toBe(
        "Checking spacing",
      );
      expect(row?.getAttribute("aria-label")).toBe(
        `Open subagent details for ${label}. ${description}`,
      );
      row?.click();
      expect(onOpenTaskDetail).toHaveBeenCalledWith(task);
    },
  );

  it("keeps activity rows non-interactive when no open callback is provided", () => {
    const task = makeTask({ id: "status-only-subagent" });
    const container = renderStatusRow({
      tasks: [task],
      subagentActivity: deriveSubagentActivity({
        tasks: [task],
        sessionKey: "agent:main:current",
        canonicalizeSessionKey: (sessionKey) => sessionKey ?? "",
      }),
    });

    const row = container.querySelector('[data-subagent-task-id="status-only-subagent"]');
    expect(row?.tagName).toBe("DIV");
    expect(row?.getAttribute("role")).toBe("status");
    expect(row?.hasAttribute("tabindex")).toBe(false);
  });

  it("shows only ongoing children for the requester and leaves other work in the aggregate", () => {
    const now = 100_000;
    const current = makeTask({
      id: "current-subagent",
      lastActivity: "Reviewing the current session",
      updatedAt: now,
    });
    const recent = makeTask({
      id: "recent-subagent",
      status: "completed",
      updatedAt: now - 1_000,
      endedAt: now - 1_000,
      terminalSummary: "Review complete",
    });
    const otherRuntime = makeTask({
      id: "other-runtime",
      runtime: "cli",
      lastActivity: "CLI task",
    });
    const tasks = [
      current,
      recent,
      makeTask({
        id: "other-session",
        sessionKey: "agent:main:other",
        lastActivity: "Wrong requester",
      }),
      otherRuntime,
      ...(["completed", "failed", "cancelled", "timed_out"] as const).map((status) =>
        makeTask({ id: `terminal-${status}`, status, endedAt: now, updatedAt: now }),
      ),
      makeTask({ id: "finished-execution", execution: { state: "finished" } }),
    ];
    const subagentActivity = deriveSubagentActivity({
      tasks,
      sessionKey: "agent:main:current",
      canonicalizeSessionKey: (sessionKey) => sessionKey ?? "",
    });

    expect(subagentActivity.rows.map((task) => task.id)).toEqual(["current-subagent"]);

    const container = renderStatusRow({
      tasks: [current, recent, otherRuntime],
      subagentActivity,
    });
    expect(container.querySelectorAll(".chat-subagent-activity__row")).toHaveLength(1);
    expect(container.textContent).toContain("Reviewing the current session");
    expect(container.querySelector('[data-subagent-task-id="recent-subagent"]')).toBeNull();
    expect(container.textContent).not.toContain("Review complete");
    expect(container.textContent).not.toContain("Wrong requester");
    expect(container.querySelector(".chat-tasks-status__link")?.textContent?.trim()).toBe(
      "1 running task",
    );
  });

  it("caps visible rows at five and includes waiting and queued children in the overflow", () => {
    const running = Array.from({ length: 7 }, (_, index) =>
      makeTask({
        id: `running-${index}`,
        lastActivity: `Running child ${index}`,
        updatedAt: 10_000 - index,
        ...(index >= 5 ? { execution: { state: "waiting" as const } } : {}),
      }),
    );
    const queued = Array.from({ length: 2 }, (_, index) =>
      makeTask({ id: `queued-${index}`, status: "queued", updatedAt: 1_000 - index }),
    );
    const subagentActivity = deriveSubagentActivity({
      tasks: [...running, ...queued],
      sessionKey: "agent:main:current",
      canonicalizeSessionKey: (sessionKey) => sessionKey ?? "",
    });
    const container = renderStatusRow({
      tasks: [...running, ...queued],
      subagentActivity,
    });

    expect(container.querySelectorAll(".chat-subagent-activity__row")).toHaveLength(5);
    expect(container.querySelector(".chat-subagent-activity__overflow")?.textContent?.trim()).toBe(
      "+4 more subagents",
    );
    expect(container.querySelector(".chat-tasks-status")).toBeNull();
  });

  it.each([false, true])(
    "keeps creation order through activity and wait changes (ISO dates: %s)",
    async (isoDates) => {
      const tasks = Array.from({ length: 6 }, (_, index) =>
        makeTask({
          id: `running-${index}`,
          createdAt: isoDates ? new Date(1_000 + index).toISOString() : 1_000 + index,
          updatedAt: 10_000 - index,
          status: index === 2 ? "queued" : "running",
        }),
      );
      const { host } = createHost(...tasks.toReversed());
      createBackgroundTasksProps(host);
      await flushAsync();
      const container = document.createElement("div");
      document.body.append(container);
      const renderCurrent = () =>
        render(
          html`${renderBackgroundTasksStatusRow(createBackgroundTasksProps(host))}`,
          container,
        );
      const rowIds = () =>
        Array.from(container.querySelectorAll("[data-subagent-task-id]"), (row) =>
          row.getAttribute("data-subagent-task-id"),
        );
      const expected = tasks.slice(0, 5).map((task) => task.id);
      renderCurrent();
      expect(rowIds()).toEqual(expected);
      const firstRow = container.querySelector("[data-subagent-task-id]");
      for (const index of [5, 2, 1]) {
        const task = tasks[index];
        handleBackgroundTasksEvent(host, {
          action: "upserted",
          task: {
            ...task,
            status: "running",
            updatedAt: 20_000 + index,
            execution: {
              state: "waiting",
              lastActivityAt: 30_000 + index,
              wait: { kind: "approval" },
            },
            lastActivity: "Waiting for approval",
          },
        });
        renderCurrent();
        expect(rowIds()).toEqual(expected);
        expect(container.querySelector("[data-subagent-task-id]")).toBe(firstRow);
      }
      expect(
        container.querySelector(".chat-subagent-activity__overflow")?.textContent?.trim(),
      ).toBe("+1 more subagents");
    },
  );

  it.each(["completed", "failed", "cancelled", "timed_out"] as const)(
    "removes a %s result immediately and keeps it in Tasks through delivery updates",
    async (status) => {
      const tasks = Array.from({ length: 3 }, (_, index) =>
        makeTask({ id: String(index), createdAt: 1_000 + index, updatedAt: 2_000 + index }),
      );
      const { host } = createHost(...tasks);
      createBackgroundTasksProps(host);
      await flushAsync();
      const ids = () =>
        createBackgroundTasksProps(host).subagentActivity.rows.map((task) => task.id);
      const finishedFirst = { ...tasks[1], status, endedAt: 100_000, updatedAt: 100_000 };
      handleBackgroundTasksEvent(host, { action: "upserted", task: finishedFirst });
      expect(ids()).toEqual(["0", "2"]);
      handleBackgroundTasksEvent(host, {
        action: "upserted",
        task: { ...tasks[2], status: "completed", endedAt: 101_000, updatedAt: 101_000 },
      });
      expect(ids()).toEqual(["0"]);
      handleBackgroundTasksEvent(host, {
        action: "upserted",
        task: { ...finishedFirst, updatedAt: 102_000, deliveryStatus: "delivered" },
      });
      expect(ids()).toEqual(["0"]);
      expect(createBackgroundTasksProps(host).tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "1", status, deliveryStatus: "delivered" }),
          expect.objectContaining({ id: "2", status: "completed" }),
        ]),
      );
    },
  );

  it("keeps ongoing work visible during a completion burst and counts every overflow row", () => {
    const active = Array.from({ length: 6 }, (_, index) =>
      makeTask({ id: `active-${index}`, createdAt: 1_000 + index }),
    );
    const finished = Array.from({ length: 55 }, (_, index) =>
      makeTask({
        id: `finished-${index}`,
        status: "completed",
        endedAt: 90_000 + index,
        updatedAt: 100_000 - index,
      }),
    );
    const presentation = deriveSubagentActivity({
      tasks: [...active, ...finished],
      sessionKey: "agent:main:current",
      canonicalizeSessionKey: (key) => key ?? "",
    });
    expect(presentation.rows.map((task) => task.id)).toEqual([
      "active-0",
      "active-1",
      "active-2",
      "active-3",
      "active-4",
    ]);
    expect(presentation.overflowCount).toBe(1);
    expect(presentation.taskIds.size).toBe(61);
  });

  it("retires live text but retains diff stats through terminal activity", async () => {
    const running = makeTask({
      id: "retained-subagent",
      lastActivity: "Editing the final report",
      diffStat: { files: 2, added: 12, removed: 3 },
    });
    const { host } = createHost(running);
    createBackgroundTasksProps(host);
    await flushAsync();

    handleBackgroundTasksEvent(host, {
      action: "upserted",
      task: makeTask({
        id: "retained-subagent",
        status: "cancelled",
        updatedAt: 100_000,
        endedAt: 100_000,
        lastToolName: "read_file",
        progressSummary: "Outdated progress",
      }),
    });
    const props = createBackgroundTasksProps(host);
    expect(props.tasks?.[0]).toMatchObject({
      status: "cancelled",
      diffStat: { files: 2, added: 12, removed: 3 },
    });
    expect(props.tasks?.[0]).not.toHaveProperty("lastActivity");

    const container = document.createElement("div");
    document.body.append(container);
    const renderCurrent = () =>
      render(html`${renderBackgroundTasksStatusRow(createBackgroundTasksProps(host))}`, container);
    renderCurrent();
    expect(container.querySelector(".chat-subagent-activity__row")).toBeNull();
    expect(container.textContent).not.toContain("Editing the final report");
    expect(container.textContent).not.toContain("Outdated progress");
    expect(container.textContent).not.toContain("read_file");
    expect(container.querySelector(".chat-diffstat")).toBeNull();
  });
});
