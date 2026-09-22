import { vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { TaskSummary } from "../lib/tasks/task-summary.ts";
import type { BackgroundTasksHost } from "../pages/chat/components/chat-background-tasks.ts";

export function flushAsync() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function makeTask(overrides: Partial<TaskSummary> & { id: string }): TaskSummary {
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

export function createHost(options?: {
  request?: (method: string, params?: unknown) => Promise<unknown>;
  connected?: boolean;
}): {
  host: BackgroundTasksHost;
  request: ReturnType<typeof vi.fn>;
  requestUpdate: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(
    options?.request ??
      ((method: string) => {
        if (method === "tasks.list") {
          return Promise.resolve({ tasks: [] });
        }
        return Promise.resolve({});
      }),
  );
  const requestUpdate = vi.fn();
  const host: BackgroundTasksHost = {
    sessionKey: "agent:main:current",
    client: { request } as unknown as GatewayBrowserClient,
    connected: options?.connected ?? true,
    hello: null,
    requestUpdate,
  };
  return { host, request, requestUpdate };
}
