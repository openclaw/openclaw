import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadA2ATaskRecordFromEventLog } from "../a2a/log.js";
import { A2ABrokerClientError, type A2ABrokerTaskRecord } from "../a2a/standalone-broker-client.js";
import type { A2AExchangeRequest } from "./sessions-send-broker.js";
import {
  __testing,
  createStandaloneBrokerSessionsSendA2AAdapter,
  shouldUseStandaloneBrokerSessionsSendAdapter,
} from "./sessions-send-standalone-broker-adapter.js";

const tempDirs: string[] = [];
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

function createConfig() {
  return {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            baseUrl: "https://broker.example.com",
          },
        },
      },
    },
  } as never;
}

function createRequest(taskId: string): A2AExchangeRequest {
  return {
    requester: {
      sessionKey: "agent:main:telegram:direct:req",
      displayKey: "agent:main:telegram:direct:req",
      channel: "telegram",
    },
    target: {
      sessionKey: "agent:worker:main",
      displayKey: "agent:worker:main",
    },
    originalMessage: `Investigate ${taskId}`,
    announceTimeoutMs: 15_000,
    maxPingPongTurns: 1,
    waitRunId: `${taskId}-run`,
    correlationId: `${taskId}-corr`,
    parentRunId: `${taskId}-parent`,
    cancelTarget: {
      kind: "session_run",
      sessionKey: "agent:worker:main",
      runId: `${taskId}-remote-run`,
    },
  };
}

function createBrokerTaskRecord(
  taskId: string,
  status: A2ABrokerTaskRecord["status"],
  overrides: Partial<A2ABrokerTaskRecord> = {},
): A2ABrokerTaskRecord {
  return {
    id: taskId,
    intent: "chat",
    requester: {
      id: "hub-a",
      kind: "service",
      role: "hub",
    },
    target: {
      id: "worker-a",
      kind: "node",
    },
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    status,
    message: `Investigate ${taskId}`,
    payload: {
      targetSessionKey: "agent:worker:main",
      targetDisplayKey: "agent:worker:main",
      waitRunId: `${taskId}-run`,
      correlationId: `${taskId}-corr`,
      parentRunId: `${taskId}-parent`,
      requesterSessionKey: "agent:main:telegram:direct:req",
      requesterChannel: "telegram",
      cancelTarget: {
        kind: "session_run",
        sessionKey: "agent:worker:main",
        runId: `${taskId}-remote-run`,
      },
    },
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
    ...overrides,
  };
}

async function makeStateDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-a2a-standalone-"));
  tempDirs.push(dir);
  process.env.OPENCLAW_STATE_DIR = dir;
}

beforeEach(async () => {
  await makeStateDir();
});

afterEach(async () => {
  __testing.setCreateClientForTest();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("standalone broker sessions_send adapter", () => {
  it("uses standalone routing only when plugin is enabled and baseUrl is configured", () => {
    expect(shouldUseStandaloneBrokerSessionsSendAdapter(createConfig())).toBe(true);
    expect(
      shouldUseStandaloneBrokerSessionsSendAdapter({
        plugins: {
          entries: {
            "a2a-broker-adapter": {
              enabled: false,
              config: {
                baseUrl: "https://broker.example.com",
              },
            },
          },
        },
      } as never),
    ).toBe(false);
    expect(
      shouldUseStandaloneBrokerSessionsSendAdapter({
        plugins: {
          entries: {
            "a2a-broker-adapter": {
              enabled: true,
              config: {},
            },
          },
        },
      } as never),
    ).toBe(false);
  });

  it("reconciles queued, claimed, running, and succeeded states into the A2A event log", async () => {
    const taskId = "task-broker-seq-1";
    const request = createRequest(taskId);
    const getTask = vi
      .fn()
      .mockResolvedValueOnce(
        createBrokerTaskRecord(taskId, "claimed", {
          claimedAt: "2026-04-15T00:00:05.000Z",
          updatedAt: "2026-04-15T00:00:05.000Z",
        }),
      )
      .mockResolvedValueOnce(
        createBrokerTaskRecord(taskId, "running", {
          claimedAt: "2026-04-15T00:00:05.000Z",
          updatedAt: "2026-04-15T00:00:10.000Z",
        }),
      )
      .mockResolvedValueOnce(
        createBrokerTaskRecord(taskId, "succeeded", {
          claimedAt: "2026-04-15T00:00:05.000Z",
          updatedAt: "2026-04-15T00:00:20.000Z",
          completedAt: "2026-04-15T00:00:20.000Z",
          result: {
            summary: "Broker completed the delegation",
            output: {
              latestReply: "done",
            },
          },
        }),
      );
    const cancelTask = vi.fn();

    __testing.setCreateClientForTest(
      () =>
        ({
          createTask: vi.fn().mockResolvedValue(createBrokerTaskRecord(taskId, "queued")),
          getTask,
          cancelTask,
        }) as never,
    );

    const adapter = createStandaloneBrokerSessionsSendA2AAdapter({ config: createConfig() });
    const created = await adapter.runTaskRequest({ request, taskId: request.waitRunId });
    expect(created.execution.status).toBe("accepted");

    const claimed = await adapter.reconcileTaskStatus?.({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(claimed).toMatchObject({
      executionStatus: "accepted",
      hasHeartbeat: true,
    });

    const running = await adapter.reconcileTaskStatus?.({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(running).toMatchObject({
      executionStatus: "running",
      hasHeartbeat: true,
    });

    const completed = await adapter.reconcileTaskStatus?.({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(completed).toMatchObject({
      executionStatus: "completed",
      deliveryStatus: "skipped",
      summary: "Broker completed the delegation",
    });

    const finalRecord = await loadA2ATaskRecordFromEventLog({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(finalRecord).toMatchObject({
      execution: {
        status: "completed",
      },
      delivery: {
        status: "skipped",
      },
      result: {
        summary: "Broker completed the delegation",
      },
    });
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it("maps broker canceled tasks onto OpenClaw cancelled status", async () => {
    const taskId = "task-broker-cancelled-1";
    const request = createRequest(taskId);

    __testing.setCreateClientForTest(
      () =>
        ({
          createTask: vi.fn().mockResolvedValue(createBrokerTaskRecord(taskId, "queued")),
          getTask: vi.fn().mockResolvedValue(
            createBrokerTaskRecord(taskId, "canceled", {
              updatedAt: "2026-04-15T00:00:30.000Z",
              completedAt: "2026-04-15T00:00:30.000Z",
              result: {
                note: "user canceled the task",
              },
            }),
          ),
          cancelTask: vi.fn(),
        }) as never,
    );

    const adapter = createStandaloneBrokerSessionsSendA2AAdapter({ config: createConfig() });
    await adapter.runTaskRequest({ request, taskId: request.waitRunId });
    const cancelled = await adapter.reconcileTaskStatus?.({
      sessionKey: request.target.sessionKey,
      taskId,
    });

    expect(cancelled).toMatchObject({
      executionStatus: "cancelled",
      deliveryStatus: "skipped",
      error: {
        message: "user canceled the task",
      },
    });
  });

  it("maps broker timeout failures onto timed_out", async () => {
    const taskId = "task-broker-timeout-1";
    const request = createRequest(taskId);

    __testing.setCreateClientForTest(
      () =>
        ({
          createTask: vi.fn().mockResolvedValue(
            createBrokerTaskRecord(taskId, "failed", {
              updatedAt: "2026-04-15T00:00:30.000Z",
              completedAt: "2026-04-15T00:00:30.000Z",
              error: {
                code: "timeout",
                message: "worker timed out",
              },
            }),
          ),
          getTask: vi.fn(),
          cancelTask: vi.fn(),
        }) as never,
    );

    const adapter = createStandaloneBrokerSessionsSendA2AAdapter({ config: createConfig() });
    const result = await adapter.runTaskRequest({ request, taskId: request.waitRunId });

    expect(result).toMatchObject({
      execution: {
        status: "timed_out",
        errorCode: "timeout",
        errorMessage: "worker timed out",
      },
      delivery: {
        status: "skipped",
      },
    });
  });

  it("maps broker sync failures onto stable protocol error codes", async () => {
    const taskId = "task-broker-unavailable-1";
    const request = createRequest(taskId);

    __testing.setCreateClientForTest(
      () =>
        ({
          createTask: vi.fn().mockResolvedValue(createBrokerTaskRecord(taskId, "queued")),
          getTask: vi
            .fn()
            .mockRejectedValueOnce(new A2ABrokerClientError("task missing", 404, "not_found"))
            .mockRejectedValueOnce(new A2ABrokerClientError("bad edge secret", 401, "unauthorized"))
            .mockRejectedValueOnce(
              new A2ABrokerClientError("broker unavailable", 503, "unavailable"),
            )
            .mockRejectedValueOnce(
              new z.ZodError([
                {
                  code: "custom",
                  message: "malformed response",
                  path: ["status"],
                },
              ]),
            )
            .mockRejectedValueOnce(
              Object.assign(new Error("request timed out"), { name: "AbortError" }),
            ),
          cancelTask: vi.fn(),
        }) as never,
    );

    const adapter = createStandaloneBrokerSessionsSendA2AAdapter({ config: createConfig() });
    await adapter.runTaskRequest({ request, taskId: request.waitRunId });

    const notFound = await adapter.reconcileTaskStatus?.({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(notFound).toMatchObject({
      executionStatus: "waiting_external",
      error: {
        code: "broker_task_not_found",
        message: "task missing",
      },
    });

    const auth = await adapter.reconcileTaskStatus?.({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(auth).toMatchObject({
      executionStatus: "waiting_external",
      error: {
        code: "broker_auth_or_config_error",
        message: "bad edge secret",
      },
    });

    const transient = await adapter.reconcileTaskStatus?.({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(transient).toMatchObject({
      executionStatus: "waiting_external",
      error: {
        code: "broker_transient_fetch_error",
        message: "broker unavailable",
      },
    });

    const malformed = await adapter.reconcileTaskStatus?.({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(malformed).toMatchObject({
      executionStatus: "waiting_external",
      error: {
        code: "broker_malformed_response",
      },
    });

    const timedOut = await adapter.reconcileTaskStatus?.({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(timedOut).toMatchObject({
      executionStatus: "waiting_external",
      error: {
        code: "broker_timeout",
        message: "request timed out",
      },
    });
  });

  it("wires OpenClaw task cancellation through broker cancelTask", async () => {
    const taskId = "task-broker-cancel-e2e-1";
    const request = {
      ...createRequest(taskId),
      cancelTarget: {
        kind: "session_run",
        sessionKey: "agent:worker:main",
        runId: "different-remote-run-id",
      },
    } satisfies A2AExchangeRequest;
    const cancelTask = vi.fn().mockResolvedValue(
      createBrokerTaskRecord(taskId, "canceled", {
        updatedAt: "2026-04-15T00:00:40.000Z",
        completedAt: "2026-04-15T00:00:40.000Z",
      }),
    );
    const createTask = vi.fn().mockResolvedValue(
      createBrokerTaskRecord(taskId, "running", {
        claimedAt: "2026-04-15T00:00:05.000Z",
        updatedAt: "2026-04-15T00:00:10.000Z",
        payload: {
          targetSessionKey: "agent:worker:main",
          targetDisplayKey: "agent:worker:main",
          waitRunId: `${taskId}-run`,
          correlationId: `${taskId}-corr`,
          parentRunId: `${taskId}-parent`,
          requesterSessionKey: "agent:main:telegram:direct:req",
          requesterChannel: "telegram",
          cancelTarget: request.cancelTarget,
        },
      }),
    );

    __testing.setCreateClientForTest(
      () =>
        ({
          createTask,
          getTask: vi.fn(),
          cancelTask,
        }) as never,
    );

    const adapter = createStandaloneBrokerSessionsSendA2AAdapter({ config: createConfig() });
    await adapter.runTaskRequest({ request, taskId: request.waitRunId });
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          cancelTarget: {
            kind: "session_run",
            sessionKey: "agent:worker:main",
            runId: "different-remote-run-id",
          },
        }),
      }),
    );
    const seededRecord = await loadA2ATaskRecordFromEventLog({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(seededRecord?.envelope.runtime?.cancelTarget).toEqual({
      kind: "session_run",
      sessionKey: "agent:worker:main",
      runId: "different-remote-run-id",
    });

    const cancelled = await adapter.cancelTask?.({
      sessionKey: request.target.sessionKey,
      taskId,
      reason: "operator requested cancel",
    });

    expect(cancelTask).toHaveBeenCalledWith(taskId, {
      reason: "operator requested cancel",
    });
    expect(cancelled).toMatchObject({
      abortStatus: "aborted",
      executionStatus: "cancelled",
    });
  });
});
