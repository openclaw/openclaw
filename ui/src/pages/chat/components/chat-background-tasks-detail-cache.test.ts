import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import {
  createBackgroundTasksProps,
  handleBackgroundTasksEvent,
  type BackgroundTasksHost,
} from "./chat-background-tasks.ts";

function flushAsync() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function makeTask(overrides: Partial<TaskSummary> & { id: string }): TaskSummary {
  return {
    taskId: overrides.id,
    status: "running",
    runtime: "cli",
    agentId: "main",
    title: "pnpm test",
    sessionKey: "agent:main:current",
    createdAt: 1_000,
    updatedAt: 2_000,
    startedAt: 1_500,
    ...overrides,
  };
}

function createHost(
  request: (method: string, params?: unknown) => Promise<unknown>,
): BackgroundTasksHost {
  return {
    sessionKey: "agent:main:current",
    client: { request: vi.fn(request) } as unknown as GatewayBrowserClient,
    connected: true,
    hello: null,
    requestUpdate: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// The cached detail map is what both the rail inspector and the task panel read
// before they issue their own `tasks.get`, so a lookup taken while a task was
// still running must never be allowed to stand in for the finished record: the
// terminal-only output tail only exists on the completed row.
describe("task detail cache invalidation", () => {
  it("invalidates a cached running lookup when a refresh reports completion", async () => {
    const running = makeTask({ id: "task-1", status: "running" });
    const terminal = makeTask({
      id: "task-1",
      status: "completed",
      updatedAt: 3_000,
      endedAt: 3_000,
      terminalSummary: "Command completed",
    });
    let listed: TaskSummary = running;
    let lookups = 0;
    const host = createHost((method) => {
      if (method !== "tasks.get") {
        return Promise.resolve({ tasks: [listed] });
      }
      lookups += 1;
      return Promise.resolve({
        task:
          lookups === 1
            ? { ...running, prompt: "pnpm test" }
            : { ...terminal, prompt: "pnpm test", result: "final output tail" },
      });
    });
    createBackgroundTasksProps(host);
    await flushAsync();

    createBackgroundTasksProps(host, { onOpenTaskDetail: () => {} }).onLoadDetail?.(running);
    await flushAsync();
    expect(createBackgroundTasksProps(host).taskDetails.has("task-1")).toBe(true);

    // No completion event reaches the rail here; the refresh alone reports the
    // finished row, which is the same proof that the cached lookup is stale.
    listed = terminal;
    createBackgroundTasksProps(host).onRefresh?.();
    await flushAsync();

    const refreshed = createBackgroundTasksProps(host);
    expect(refreshed.tasks?.map((task) => task.status)).toEqual(["completed"]);
    expect(refreshed.taskDetails.has("task-1")).toBe(false);

    createBackgroundTasksProps(host, { onOpenTaskDetail: () => {} }).onLoadDetail?.(terminal);
    await flushAsync();

    expect(lookups).toBe(2);
    expect(createBackgroundTasksProps(host).taskDetails.get("task-1")?.result).toBe(
      "final output tail",
    );
  });

  it("rejects a running lookup that lands after the list reported completion", async () => {
    const running = makeTask({ id: "task-2", status: "running" });
    const terminal = makeTask({
      id: "task-2",
      status: "completed",
      updatedAt: 3_000,
      endedAt: 3_000,
      terminalSummary: "Command completed",
    });
    const lookup = createDeferred<unknown>();
    let lookups = 0;
    const host = createHost((method) => {
      if (method !== "tasks.get") {
        return Promise.resolve({ tasks: [running] });
      }
      lookups += 1;
      return lookups === 1
        ? lookup.promise
        : Promise.resolve({
            task: { ...terminal, prompt: "pnpm test", result: "final output tail" },
          });
    });
    createBackgroundTasksProps(host);
    await flushAsync();

    createBackgroundTasksProps(host, { onOpenTaskDetail: () => {} }).onLoadDetail?.(running);
    // Completion is observed while the running lookup is still in flight, so
    // its late response must not be cached as the finished record.
    handleBackgroundTasksEvent(host, { action: "upserted", task: terminal });
    lookup.resolve({ task: { ...running, prompt: "pnpm test" } });
    await flushAsync();

    expect(createBackgroundTasksProps(host).taskDetails.has("task-2")).toBe(false);

    createBackgroundTasksProps(host, { onOpenTaskDetail: () => {} }).onLoadDetail?.(terminal);
    await flushAsync();

    expect(lookups).toBe(2);
    expect(createBackgroundTasksProps(host).taskDetails.get("task-2")?.result).toBe(
      "final output tail",
    );
  });
});
