import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  cancelOperatorWorkerTask,
  getOperatorWorkerReady,
  getOperatorWorkerTask,
  getOperatorWorkerTaskEvents,
  isOperatorWorkerClientError,
  listOperatorWorkerTasks,
} from "./worker-client.js";

describe("operator worker client", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("lists worker tasks from the configured 2Tony base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          tasks: [
            {
              taskId: "worker-task-1",
              runId: "run-1",
              type: "backend",
              priority: "normal",
              state: "queued",
              attempt: 0,
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_000_100,
            },
          ],
          stats: {
            pending: 1,
            active: 0,
            shuttingDown: false,
          },
        }),
      status: 200,
      statusText: "OK",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await withEnvAsync(
      {
        OPENCLAW_OPERATOR_2TONY_URL: "http://2tony.internal:3009",
        OPENCLAW_OPERATOR_2TONY_SHARED_SECRET: "worker-secret",
      },
      async () => await listOperatorWorkerTasks(25),
    );

    expect(result.tasks[0]?.taskId).toBe("worker-task-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://2tony.internal:3009/tasks?limit=25",
      expect.objectContaining({
        headers: {
          accept: "application/json",
          authorization: "Bearer worker-secret",
        },
      }),
    );
  });

  it("proxies detail, events, and cancel requests to the worker", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            taskId: "worker-task-2",
            runId: "run-2",
            type: "infra",
            priority: "high",
            state: "started",
            attempt: 1,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_100,
          }),
        status: 200,
        statusText: "OK",
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            taskId: "worker-task-2",
            runId: "run-2",
            events: [
              {
                id: "evt-1",
                at: 1_700_000_000_100,
                state: "queued",
              },
            ],
          }),
        status: 200,
        statusText: "OK",
      })
      .mockResolvedValueOnce({
        ok: false,
        text: async () =>
          JSON.stringify({
            taskId: "worker-task-2",
            cancelled: false,
            message: "active-task cancellation not supported yet",
            task: {
              taskId: "worker-task-2",
              runId: "run-2",
              type: "infra",
              priority: "high",
              state: "started",
              attempt: 1,
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_000_100,
            },
          }),
        status: 409,
        statusText: "Conflict",
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await withEnvAsync(
      {
        OPENCLAW_OPERATOR_2TONY_URL: "http://2tony.internal:3009",
        OPENCLAW_OPERATOR_2TONY_SHARED_SECRET: "worker-secret",
      },
      async () => {
        const task = await getOperatorWorkerTask("worker-task-2");
        expect(task.state).toBe("started");

        const events = await getOperatorWorkerTaskEvents("worker-task-2");
        expect(events.events[0]?.state).toBe("queued");

        await expect(cancelOperatorWorkerTask("worker-task-2")).resolves.toMatchObject({
          cancelled: false,
          message: "active-task cancellation not supported yet",
        });
      },
    );
  });

  it("loads worker readiness including backend persistence details", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          status: "ok",
          pending: 2,
          active: 1,
          shuttingDown: false,
          auth: {
            enabled: true,
            scheme: "bearer",
          },
          backend: {
            mode: "filesystem",
            persistenceEnabled: true,
            stateFile: "/var/lib/agents/2tony/queue-state.json",
            recoveredTasks: 3,
          },
        }),
      status: 200,
      statusText: "OK",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await withEnvAsync(
      {
        OPENCLAW_OPERATOR_2TONY_URL: "http://2tony.internal:3009",
        OPENCLAW_OPERATOR_2TONY_SHARED_SECRET: "worker-secret",
      },
      async () => await getOperatorWorkerReady(),
    );

    expect(result).toMatchObject({
      status: "ok",
      auth: {
        enabled: true,
        scheme: "bearer",
      },
      backend: {
        mode: "filesystem",
        recoveredTasks: 3,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://2tony.internal:3009/ready",
      expect.objectContaining({
        headers: {
          accept: "application/json",
          authorization: "Bearer worker-secret",
        },
      }),
    );
  });

  it("omits worker authorization headers when no secret is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          tasks: [],
          stats: {
            pending: 0,
            active: 0,
            shuttingDown: false,
          },
        }),
      status: 200,
      statusText: "OK",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await withEnvAsync(
      {
        OPENCLAW_OPERATOR_2TONY_URL: "http://2tony.internal:3009",
        OPENCLAW_OPERATOR_2TONY_SHARED_SECRET: undefined,
        BT_2TONY_SHARED_SECRET: undefined,
        TWO_TONY_SHARED_SECRET: undefined,
      },
      async () => await listOperatorWorkerTasks(),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://2tony.internal:3009/tasks?limit=50",
      expect.objectContaining({
        headers: {
          accept: "application/json",
        },
      }),
    );
  });

  it("fails clearly when 2Tony is not configured", async () => {
    await withEnvAsync(
      {
        OPENCLAW_OPERATOR_2TONY_URL: undefined,
        BT_2TONY_BASE_URL: undefined,
        TWO_TONY_BASE_URL: undefined,
      },
      async () => {
        await expect(listOperatorWorkerTasks()).rejects.toSatisfy((error: unknown) => {
          expect(isOperatorWorkerClientError(error)).toBe(true);
          expect((error as Error).message).toBe("2Tony base URL not configured");
          return true;
        });
      },
    );
  });
});
