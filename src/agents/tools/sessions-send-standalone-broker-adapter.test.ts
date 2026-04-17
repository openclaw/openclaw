import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadA2ATaskRecordFromEventLog, readA2ATaskEvents } from "../a2a/log.js";
import {
  A2ABrokerClientError,
  type A2ABrokerTaskRecord,
  type A2ABrokerTaskSseEvent,
} from "../a2a/standalone-broker-client.js";
import type { A2AExchangeRequest } from "./sessions-send-broker.js";
import {
  __testing,
  createStandaloneBrokerSessionsSendA2AAdapter,
  shouldUseStandaloneBrokerSessionsSendAdapter,
  subscribeStandaloneBrokerA2ATask,
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
  it("uses standalone routing only when plugin activation is explicit and baseUrl is configured", () => {
    expect(shouldUseStandaloneBrokerSessionsSendAdapter(createConfig())).toBe(true);
    expect(
      shouldUseStandaloneBrokerSessionsSendAdapter({
        plugins: {
          allow: ["a2a-broker-adapter"],
          entries: {
            "a2a-broker-adapter": {
              config: {
                baseUrl: "https://broker.example.com",
              },
            },
          },
        },
      } as never),
    ).toBe(true);
    expect(
      shouldUseStandaloneBrokerSessionsSendAdapter({
        plugins: {
          allow: ["browser"],
          entries: {
            "a2a-broker-adapter": {
              enabled: true,
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
          enabled: false,
          entries: {
            "a2a-broker-adapter": {
              enabled: true,
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

  it("drives reconcile from broker SSE events and stops on the terminal frame", async () => {
    const taskId = "task-broker-stream-1";
    const request = createRequest(taskId);

    function buildSseEvent(
      name: A2ABrokerTaskSseEvent["name"],
      reason: string,
      internalStatus: A2ABrokerTaskRecord["status"],
      final: boolean,
    ): A2ABrokerTaskSseEvent {
      const projection = {
        id: taskId,
        kind: "task" as const,
        status: {
          state: internalStatus === "succeeded" ? "completed" : "working",
          timestamp: "2026-04-15T00:00:10.000Z",
        },
        metadata: {
          internalStatus,
          intent: "chat",
          requester: { id: "hub-a", kind: "service", role: "hub" },
          target: { id: "worker-a", kind: "node" },
          targetNodeId: "worker-a",
          assignedWorkerId: "worker-a",
          createdAt: "2026-04-15T00:00:00.000Z",
          updatedAt: "2026-04-15T00:00:10.000Z",
        },
        artifacts: [],
      };
      return {
        name,
        data: {
          task: projection,
          reason: reason as never,
          final,
        } as never,
      };
    }

    const events: A2ABrokerTaskSseEvent[] = [
      buildSseEvent("task-snapshot", "snapshot", "queued", false),
      buildSseEvent("task-status-update", "started", "running", false),
      buildSseEvent("task-status-update", "succeeded", "succeeded", true),
    ];

    async function* streamTaskEvents(): AsyncGenerator<A2ABrokerTaskSseEvent> {
      for (const event of events) {
        yield event;
      }
    }

    // First reconcile after snapshot still sees "queued"; second sees "running"; third sees terminal "succeeded".
    const getTask = vi
      .fn()
      .mockResolvedValueOnce(createBrokerTaskRecord(taskId, "queued"))
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
            summary: "Streamed completion",
          },
        }),
      );

    __testing.setCreateClientForTest(
      () =>
        ({
          createTask: vi.fn().mockResolvedValue(createBrokerTaskRecord(taskId, "queued")),
          getTask,
          cancelTask: vi.fn(),
          streamTaskEvents,
        }) as never,
    );

    // Seed the event log so reconcile has something to update.
    const adapter = createStandaloneBrokerSessionsSendA2AAdapter({ config: createConfig() });
    await adapter.runTaskRequest({ request, taskId: request.waitRunId });

    const observedEvents: A2ABrokerTaskSseEvent[] = [];
    const result = await subscribeStandaloneBrokerA2ATask({
      config: createConfig(),
      sessionKey: request.target.sessionKey,
      taskId,
      onEvent: (event) => observedEvents.push(event),
    });

    expect(observedEvents).toHaveLength(3);
    expect(result).toMatchObject({
      eventsSeen: 3,
      endedReason: "terminal",
    });
    expect(result.finalStatus).toMatchObject({
      executionStatus: "completed",
      summary: "Streamed completion",
    });
    // Reconcile fires once per SSE event - getTask is invoked exactly that many times.
    expect(getTask).toHaveBeenCalledTimes(3);
  });

  it("stops reconciling when the abort signal fires before the broker terminates", async () => {
    const taskId = "task-broker-stream-abort-1";
    const request = createRequest(taskId);
    const controller = new AbortController();

    async function* streamTaskEvents(
      _id: string,
      options?: { signal?: AbortSignal },
    ): AsyncGenerator<A2ABrokerTaskSseEvent> {
      yield {
        name: "task-snapshot",
        data: {
          task: {
            id: taskId,
            kind: "task",
            status: { state: "submitted", timestamp: "2026-04-15T00:00:00.000Z" },
            metadata: { internalStatus: "queued" },
            artifacts: [],
          },
          reason: "snapshot",
          final: false,
        } as never,
      };
      // Caller aborts after the first event; the next yield should not be observed.
      if (options?.signal?.aborted) {
        return;
      }
      yield {
        name: "task-status-update",
        data: {
          task: {
            id: taskId,
            kind: "task",
            status: { state: "working", timestamp: "2026-04-15T00:00:01.000Z" },
            metadata: { internalStatus: "claimed" },
            artifacts: [],
          },
          reason: "claimed",
          final: false,
        } as never,
      };
    }

    const getTask = vi.fn().mockResolvedValue(createBrokerTaskRecord(taskId, "queued"));
    __testing.setCreateClientForTest(
      () =>
        ({
          createTask: vi.fn().mockResolvedValue(createBrokerTaskRecord(taskId, "queued")),
          getTask,
          cancelTask: vi.fn(),
          streamTaskEvents,
        }) as never,
    );

    const adapter = createStandaloneBrokerSessionsSendA2AAdapter({ config: createConfig() });
    await adapter.runTaskRequest({ request, taskId: request.waitRunId });

    const result = await subscribeStandaloneBrokerA2ATask({
      config: createConfig(),
      sessionKey: request.target.sessionKey,
      taskId,
      signal: controller.signal,
      onEvent: () => {
        controller.abort();
      },
    });

    expect(result.endedReason).toBe("aborted");
    expect(result.eventsSeen).toBe(1);
    expect(getTask).toHaveBeenCalledTimes(1);
  });
  it("returns not-attempted when cancelling an already-completed task without writing new events", async () => {
    const taskId = "task-broker-cancel-terminal";
    const request = createRequest(taskId);

    __testing.setCreateClientForTest(
      () =>
        ({
          createTask: vi.fn().mockResolvedValue(createBrokerTaskRecord(taskId, "queued")),
          getTask: vi.fn().mockResolvedValue(
            createBrokerTaskRecord(taskId, "succeeded", {
              claimedAt: "2026-04-15T00:00:05.000Z",
              updatedAt: "2026-04-15T00:00:20.000Z",
              completedAt: "2026-04-15T00:00:20.000Z",
              result: { summary: "done" },
            }),
          ),
          cancelTask: vi.fn(),
        }) as never,
    );

    const adapter = createStandaloneBrokerSessionsSendA2AAdapter({ config: createConfig() });
    await adapter.runTaskRequest({ request, taskId: request.waitRunId });

    // Reconcile to terminal first
    await adapter.reconcileTaskStatus?.({ sessionKey: request.target.sessionKey, taskId });

    const eventsBefore = await readA2ATaskEvents({
      sessionKey: request.target.sessionKey,
      taskId,
    });

    const cancelResult = await adapter.cancelTask?.({
      sessionKey: request.target.sessionKey,
      taskId,
      reason: "too late",
    });

    expect(cancelResult).toMatchObject({
      abortStatus: "not-attempted",
      executionStatus: "completed",
    });

    // No new events should have been written
    const eventsAfter = await readA2ATaskEvents({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });

  it("records error abortStatus when broker cancelTask rejects", async () => {
    const taskId = "task-broker-cancel-reject";
    const request = createRequest(taskId);

    __testing.setCreateClientForTest(
      () =>
        ({
          createTask: vi.fn().mockResolvedValue(
            createBrokerTaskRecord(taskId, "running", {
              claimedAt: "2026-04-15T00:00:05.000Z",
              updatedAt: "2026-04-15T00:00:10.000Z",
            }),
          ),
          getTask: vi.fn(),
          cancelTask: vi
            .fn()
            .mockRejectedValue(new A2ABrokerClientError("worker refused cancel", 409, "conflict")),
        }) as never,
    );

    const adapter = createStandaloneBrokerSessionsSendA2AAdapter({ config: createConfig() });
    await adapter.runTaskRequest({ request, taskId: request.waitRunId });

    const eventsBefore = await readA2ATaskEvents({
      sessionKey: request.target.sessionKey,
      taskId,
    });

    const cancelResult = await adapter.cancelTask?.({
      sessionKey: request.target.sessionKey,
      taskId,
      reason: "operator cancel",
    });

    expect(cancelResult).toMatchObject({
      abortStatus: "error",
      executionStatus: "cancelled",
    });

    // Cancel event was still written locally despite remote failure
    const eventsAfter = await readA2ATaskEvents({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(eventsAfter).toHaveLength(eventsBefore.length + 1);
    expect(eventsAfter[eventsAfter.length - 1].type).toBe("task.cancelled");
  });

  it("does not write duplicate events on repeated reconcile with identical broker state", async () => {
    const taskId = "task-broker-dedup";
    const request = createRequest(taskId);

    const brokerTask = createBrokerTaskRecord(taskId, "running", {
      claimedAt: "2026-04-15T00:00:05.000Z",
      updatedAt: "2026-04-15T00:00:10.000Z",
    });

    __testing.setCreateClientForTest(
      () =>
        ({
          createTask: vi.fn().mockResolvedValue(createBrokerTaskRecord(taskId, "queued")),
          getTask: vi.fn().mockResolvedValue(brokerTask),
          cancelTask: vi.fn(),
        }) as never,
    );

    const adapter = createStandaloneBrokerSessionsSendA2AAdapter({ config: createConfig() });
    await adapter.runTaskRequest({ request, taskId: request.waitRunId });

    // First reconcile
    const r1 = await adapter.reconcileTaskStatus?.({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(r1?.executionStatus).toBe("running");

    const eventsAfterFirst = await readA2ATaskEvents({
      sessionKey: request.target.sessionKey,
      taskId,
    });

    // Second reconcile with identical state
    const r2 = await adapter.reconcileTaskStatus?.({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(r2?.executionStatus).toBe("running");

    const eventsAfterSecond = await readA2ATaskEvents({
      sessionKey: request.target.sessionKey,
      taskId,
    });

    // No new events written
    expect(eventsAfterSecond).toHaveLength(eventsAfterFirst.length);
  });

  it("preserves cancelled status when broker still reports active after local cancel", async () => {
    const taskId = "task-broker-cancel-then-active";
    const request = createRequest(taskId);

    const getTask = vi
      .fn()
      .mockResolvedValueOnce(
        createBrokerTaskRecord(taskId, "running", {
          claimedAt: "2026-04-15T00:00:05.000Z",
          updatedAt: "2026-04-15T00:00:10.000Z",
        }),
      )
      // After cancel, broker still says running (stale propagation)
      .mockResolvedValue(
        createBrokerTaskRecord(taskId, "running", {
          claimedAt: "2026-04-15T00:00:05.000Z",
          updatedAt: "2026-04-15T00:00:15.000Z",
        }),
      );

    __testing.setCreateClientForTest(
      () =>
        ({
          createTask: vi.fn().mockResolvedValue(
            createBrokerTaskRecord(taskId, "running", {
              claimedAt: "2026-04-15T00:00:05.000Z",
              updatedAt: "2026-04-15T00:00:10.000Z",
            }),
          ),
          getTask,
          cancelTask: vi.fn().mockResolvedValue(
            createBrokerTaskRecord(taskId, "canceled", {
              updatedAt: "2026-04-15T00:00:30.000Z",
              completedAt: "2026-04-15T00:00:30.000Z",
            }),
          ),
        }) as never,
    );

    const adapter = createStandaloneBrokerSessionsSendA2AAdapter({ config: createConfig() });
    await adapter.runTaskRequest({ request, taskId: request.waitRunId });

    // Cancel the task
    const cancelResult = await adapter.cancelTask?.({
      sessionKey: request.target.sessionKey,
      taskId,
      reason: "operator cancel",
    });
    expect(cancelResult?.executionStatus).toBe("cancelled");

    // Reconcile should preserve cancelled status (terminal early-return guard)
    const afterReconcile = await adapter.reconcileTaskStatus?.({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(afterReconcile?.executionStatus).toBe("cancelled");

    // Event log should not have regressed to running
    const record = await loadA2ATaskRecordFromEventLog({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(record?.execution.status).toBe("cancelled");
  });

  it("preserves error codes and completedAt on active-to-failed transition", async () => {
    const taskId = "task-broker-active-to-failed";
    const request = createRequest(taskId);

    __testing.setCreateClientForTest(
      () =>
        ({
          createTask: vi.fn().mockResolvedValue(createBrokerTaskRecord(taskId, "queued")),
          getTask: vi.fn().mockResolvedValue(
            createBrokerTaskRecord(taskId, "failed", {
              claimedAt: "2026-04-15T00:00:05.000Z",
              updatedAt: "2026-04-15T00:00:15.000Z",
              completedAt: "2026-04-15T00:00:15.000Z",
              error: {
                code: "WORKER_ERROR",
                message: "worker node unreachable",
              },
            }),
          ),
          cancelTask: vi.fn(),
        }) as never,
    );

    const adapter = createStandaloneBrokerSessionsSendA2AAdapter({ config: createConfig() });
    await adapter.runTaskRequest({ request, taskId: request.waitRunId });

    const result = await adapter.reconcileTaskStatus?.({
      sessionKey: request.target.sessionKey,
      taskId,
    });

    expect(result).toMatchObject({
      executionStatus: "failed",
      deliveryStatus: "skipped",
      error: {
        code: "WORKER_ERROR",
        message: "worker node unreachable",
      },
    });

    const record = await loadA2ATaskRecordFromEventLog({
      sessionKey: request.target.sessionKey,
      taskId,
    });
    expect(record?.execution.completedAt).toBe(Date.parse("2026-04-15T00:00:15.000Z"));
    expect(record?.execution.errorCode).toBe("WORKER_ERROR");
  });
});
