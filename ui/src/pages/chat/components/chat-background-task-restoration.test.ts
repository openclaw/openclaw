/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { createGatewayBrowserClientFixture } from "../chat-pane.test-support.ts";
import {
  createBackgroundTasksProps,
  handleBackgroundTasksEvent,
  type BackgroundTasksHost,
} from "./chat-background-tasks.ts";
import { renderTaskDetailPanel } from "./chat-task-detail.ts";

afterEach(() => document.body.replaceChildren());
const task: TaskSummary = {
  id: "saved-task",
  taskId: "saved-task",
  runtime: "subagent",
  status: "completed",
  agentId: "main",
  sessionKey: "agent:main:current",
  title: "Saved task",
  terminalSummary: "Saved result",
};
function fixture() {
  const pending = createDeferred<unknown>();
  const request = vi.fn((method: string) =>
    method === "tasks.get" ? pending.promise : Promise.resolve({ tasks: [] }),
  );
  const host: BackgroundTasksHost = {
    sessionKey: "agent:main:current",
    connected: true,
    connectionEpoch: 1,
    hello: null,
    client: createGatewayBrowserClientFixture({ request }),
    requestUpdate: vi.fn(),
  };
  const props = () => createBackgroundTasksProps(host, { selectedTaskId: task.id });
  return { pending, request, host, props };
}
it("loads the saved selection even when it is outside the bounded task rows", async () => {
  const f = fixture();
  const pendingProps = f.props();
  expect(pendingProps.loading).toBe(true);
  const mount = document.body.appendChild(document.createElement("div"));
  render(
    renderTaskDetailPanel({
      backgroundTasks: pendingProps,
      host: f.host,
      task: undefined,
      taskId: task.id,
    }),
    mount,
  );
  expect(mount.querySelector('openclaw-panel-loading-skeleton[aria-busy="true"]')).not.toBeNull();
  expect(mount.textContent).not.toContain("This task is no longer available.");
  await vi.waitFor(() => expect(f.props().tasks).toEqual([]));
  f.pending.resolve({ task });
  await vi.waitFor(() =>
    expect(f.props().taskDetails.get(task.id)?.terminalSummary).toBe("Saved result"),
  );
  expect(f.props().tasks).toEqual([]);
  expect(f.request.mock.calls.filter(([method]) => method === "tasks.get")).toHaveLength(1);
});
it("keeps saved selection loading with Back while initial scoped reads are deferred", () => {
  const f = fixture();
  f.host.chatSecondaryReadsReady = () => false;
  const onBack = vi.fn();
  const mount = document.body.appendChild(document.createElement("div"));
  render(
    renderTaskDetailPanel({
      backgroundTasks: f.props(),
      host: f.host,
      task: undefined,
      taskId: task.id,
      onBack,
    }),
    mount,
  );
  expect(f.request).not.toHaveBeenCalled();
  expect(mount.querySelector('openclaw-panel-loading-skeleton[aria-busy="true"]')).not.toBeNull();
  expect(mount.textContent).not.toContain("This task is no longer available.");
  [...mount.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Back to tasks")!
    .click();
  expect(onBack).toHaveBeenCalledOnce();
});
it.each(["deleted", "restored"] as const)(
  "does not publish a %s selection's old response over a newer same-ID lookup",
  async (action) => {
    const f = fixture();
    f.props();
    await vi.waitFor(() => expect(f.props().tasks).toEqual([]));
    handleBackgroundTasksEvent(
      f.host,
      action === "deleted" ? { action, taskId: task.id } : { action },
    );
    const newer = createDeferred<unknown>();
    f.request.mockImplementation((method) =>
      method === "tasks.get" ? newer.promise : Promise.resolve({ tasks: [] }),
    );
    f.props().onLoadDetail?.(task);
    f.pending.resolve({ task: { ...task, terminalSummary: "Obsolete result" } });
    await Promise.resolve();
    expect(f.props().taskDetails.has(task.id)).toBe(false);
    const pendingProps = f.props();
    expect(pendingProps.taskDetailLoadingIds.has(task.id)).toBe(true);
    const mount = document.body.appendChild(document.createElement("div"));
    render(
      renderTaskDetailPanel({
        backgroundTasks: pendingProps,
        host: f.host,
        task: undefined,
        taskId: task.id,
      }),
      mount,
    );
    expect(mount.querySelector('openclaw-panel-loading-skeleton[aria-busy="true"]')).not.toBeNull();
    expect(mount.textContent).not.toContain("This task is no longer available.");
    newer.resolve({ task: { ...task, terminalSummary: "Current result" } });
    await vi.waitFor(() =>
      expect(f.props().taskDetails.get(task.id)?.terminalSummary).toBe("Current result"),
    );
  },
);
it("keeps a failed selected lookup visible until explicit retry", async () => {
  const f = fixture();
  f.props();
  await vi.waitFor(() => expect(f.props().tasks).toEqual([]));
  f.pending.reject(new Error("Task service unavailable"));
  await vi.waitFor(() =>
    expect(f.props().taskDetailErrors.get(task.id)).toContain("Task service unavailable"),
  );
  expect(f.props().taskDetails.has(task.id)).toBe(false);
  const mount = document.body.appendChild(document.createElement("div"));
  render(
    renderTaskDetailPanel({
      backgroundTasks: f.props(),
      host: f.host,
      task: undefined,
      taskId: task.id,
    }),
    mount,
  );
  expect(mount.textContent).toContain("Task service unavailable");
  const retry = createDeferred<unknown>();
  f.request.mockImplementation((method) =>
    method === "tasks.get" ? retry.promise : Promise.resolve({ tasks: [] }),
  );
  mount.querySelector("button")?.click();
  retry.resolve({ task });
  await vi.waitFor(() =>
    expect(f.props().taskDetails.get(task.id)?.terminalSummary).toBe("Saved result"),
  );
  expect(f.request.mock.calls.filter(([method]) => method === "tasks.get")).toHaveLength(2);
});

it.each(["session", "connection"])(
  "rejects an old selected lookup after the %s changes",
  async (scope) => {
    const f = fixture();
    f.props();
    await vi.waitFor(() => expect(f.props().tasks).toEqual([]));
    if (scope === "session") {
      f.host.sessionKey = "agent:main:other";
    } else {
      f.host.connectionEpoch = 2;
    }
    f.pending.resolve({ task });
    await Promise.resolve();
    await Promise.resolve();
    const current = createBackgroundTasksProps(f.host, { presented: false });
    expect(current.taskDetails.has(task.id)).toBe(false);
  },
);

it("waits for the initial list to establish an ambiguous saved task scope", async () => {
  const f = fixture();
  const listing = createDeferred<unknown>();
  f.request.mockImplementation((method) =>
    method === "tasks.get" ? f.pending.promise : listing.promise,
  );
  const initial = f.props();
  expect(initial.loading).toBe(true);
  expect(f.request.mock.calls.filter(([method]) => method === "tasks.get")).toHaveLength(0);
  const bare = { ...task, sessionKey: "current", ownerKey: "current" };
  listing.resolve({ tasks: [bare] });
  await vi.waitFor(() => expect(f.props().tasks?.map((row) => row.id)).toEqual([task.id]));
  f.props().onLoadDetail?.(bare);
  f.pending.resolve({ task: bare });
  await vi.waitFor(() =>
    expect(f.props().taskDetails.get(task.id)?.terminalSummary).toBe("Saved result"),
  );
  expect(f.props().taskDetailErrors.has(task.id)).toBe(false);
});
it("waits for a restored list before resolving a saved task against replacement scope", async () => {
  const f = fixture();
  f.props();
  await vi.waitFor(() => expect(f.props().tasks).toEqual([]));
  f.pending.resolve({ task });
  await vi.waitFor(() => expect(f.props().taskDetails.has(task.id)).toBe(true));
  const listing = createDeferred<unknown>();
  const detail = createDeferred<unknown>();
  f.request.mockImplementation((method) =>
    method === "tasks.get" ? detail.promise : listing.promise,
  );
  handleBackgroundTasksEvent(f.host, { action: "restored" });
  expect(f.props().loading).toBe(true);
  expect(f.request.mock.calls.filter(([method]) => method === "tasks.get")).toHaveLength(1);
  const bare = { ...task, sessionKey: "current", ownerKey: "current" };
  listing.resolve({ tasks: [bare] });
  await vi.waitFor(() => expect(f.props().tasks?.map((row) => row.id)).toEqual([task.id]));
  f.props().onLoadDetail?.(bare);
  detail.resolve({ task: bare });
  await vi.waitFor(() =>
    expect(f.props().taskDetails.get(task.id)?.terminalSummary).toBe("Saved result"),
  );
  expect(f.props().taskDetailErrors.has(task.id)).toBe(false);
});
