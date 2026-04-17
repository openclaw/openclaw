import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import type { A2ATaskRecord } from "./sessions-send-broker.js";
import { mapBrokerTaskRecordToOpenClawTaskRecord } from "./sessions-send-standalone-broker-adapter.js";
import { runSessionsSendA2AFlow, __testing } from "./sessions-send-tool.a2a.js";

vi.mock("../run-wait.js", () => ({
  waitForAgentRun: vi.fn().mockResolvedValue({ status: "ok" }),
  readLatestAssistantReply: vi.fn().mockResolvedValue("Test announce reply"),
}));

vi.mock("./agent-step.js", () => ({
  runAgentStep: vi.fn().mockResolvedValue("Test announce reply"),
}));

function createAdapterTaskRecord(taskId: string): A2ATaskRecord {
  return {
    taskId,
    envelope: {
      v: 1,
      taskId,
      kind: "delegate_task",
      target: {
        sessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
      },
      task: {
        intent: "delegate",
        summary: "Adapter seam",
        instructions: "Adapter seam",
      },
    },
    execution: {
      status: "accepted",
      createdAt: 1,
      acceptedAt: 1,
    },
    delivery: {
      status: "none",
      mode: "announce",
    },
  };
}

describe("runSessionsSendA2AFlow announce delivery", () => {
  let gatewayCalls: CallGatewayOptions[];

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    gatewayCalls = [];
    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(opts: CallGatewayOptions) => {
        gatewayCalls.push(opts);
        return {} as T;
      },
    });
    __testing.setHelpersForTest({
      createEventSink: () => ({ append: async () => {} }),
    });
  });

  afterEach(() => {
    __testing.setDepsForTest();
    __testing.setHelpersForTest();
    __testing.setAdapterFactoryForTest();
    __testing.setAdapterSelectionForTest();
    vi.restoreAllMocks();
  });

  it("passes threadId through to gateway send for Telegram forum topics", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:telegram:group:-100123:topic:554",
      displayKey: "agent:main:telegram:group:-100123:topic:554",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.to).toBe("-100123");
    expect(sendParams.channel).toBe("telegram");
    expect(sendParams.threadId).toBe("554");
  });

  it("omits threadId for non-topic sessions", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.threadId).toBeUndefined();
  });
});

describe("sessions_send A2A envelope wiring", () => {
  it("builds a structured delegate task envelope from sessions_send params", () => {
    const envelope = __testing.buildTaskEnvelopeForTest({
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      targetSessionKey: "agent:worker:main",
      displayKey: "agent:worker:main",
      message: "Investigate the latest failure and report back",
      announceTimeoutMs: 15_000,
      maxPingPongTurns: 2,
      waitRunId: "run-a2a-1",
    });

    expect(envelope).toMatchObject({
      v: 1,
      taskId: "run-a2a-1",
      kind: "delegate_task",
      requester: {
        sessionKey: "agent:main:discord:group:req",
        channel: "discord",
      },
      target: {
        sessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
      },
      task: {
        intent: "delegate",
        instructions: "Investigate the latest failure and report back",
        expectedOutput: { format: "text" },
      },
      constraints: {
        timeoutSeconds: 15,
        maxPingPongTurns: 2,
        allowAnnounce: true,
      },
      trace: {
        parentRunId: "run-a2a-1",
        correlationId: "run-a2a-1",
      },
      runtime: {
        cancelTarget: {
          kind: "session_run",
          sessionKey: "agent:worker:main",
          runId: "run-a2a-1",
        },
      },
    });
  });

  it("runs through the adapter seam before touching the OpenClaw runtime", async () => {
    const runTaskRequest = vi.fn().mockResolvedValue(createAdapterTaskRecord("task-adapter-1"));
    __testing.setAdapterFactoryForTest(() => ({
      runTaskRequest,
    }));

    const record = await runSessionsSendA2AFlow({
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      targetSessionKey: "agent:worker:main",
      displayKey: "agent:worker:main",
      message: "Investigate the adapter seam",
      announceTimeoutMs: 15_000,
      maxPingPongTurns: 2,
      waitRunId: "run-adapter-1",
    });

    expect(runTaskRequest).toHaveBeenCalledWith({
      request: expect.objectContaining({
        requester: expect.objectContaining({
          sessionKey: "agent:main:discord:group:req",
          channel: "discord",
        }),
        target: expect.objectContaining({
          sessionKey: "agent:worker:main",
          displayKey: "agent:worker:main",
        }),
        originalMessage: "Investigate the adapter seam",
        announceTimeoutMs: 15_000,
        maxPingPongTurns: 2,
        waitRunId: "run-adapter-1",
        correlationId: "run-adapter-1",
        parentRunId: "run-adapter-1",
        cancelTarget: {
          kind: "session_run",
          sessionKey: "agent:worker:main",
          runId: "run-adapter-1",
        },
      }),
      taskId: "run-adapter-1",
    });
    expect(record.taskId).toBe("task-adapter-1");
  });

  it("selects the standalone broker adapter when the plugin config is enabled", async () => {
    const runTaskRequest = vi.fn().mockResolvedValue(createAdapterTaskRecord("task-broker-1"));
    __testing.setAdapterSelectionForTest({
      createBrokerAdapter: () => ({
        runTaskRequest,
      }),
    });

    const record = await runSessionsSendA2AFlow({
      requesterSessionKey: "agent:main:telegram:dm:req",
      requesterChannel: "telegram",
      targetSessionKey: "agent:worker:main",
      displayKey: "agent:worker:main",
      message: "Investigate the broker seam",
      announceTimeoutMs: 20_000,
      maxPingPongTurns: 1,
      waitRunId: "run-broker-1",
      config: {
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
      } as never,
    });

    expect(runTaskRequest).toHaveBeenCalledWith({
      request: expect.objectContaining({
        requester: expect.objectContaining({
          sessionKey: "agent:main:telegram:dm:req",
          channel: "telegram",
        }),
        originalMessage: "Investigate the broker seam",
        correlationId: "run-broker-1",
        parentRunId: "run-broker-1",
        cancelTarget: {
          kind: "session_run",
          sessionKey: "agent:worker:main",
          runId: "run-broker-1",
        },
      }),
      taskId: "run-broker-1",
    });
    expect(record.taskId).toBe("task-broker-1");
  });

  it("maps standalone broker terminal states onto the OpenClaw task shape", () => {
    const record = mapBrokerTaskRecordToOpenClawTaskRecord({
      request: {
        requester: {
          sessionKey: "agent:main:telegram:dm:req",
          displayKey: "agent:main:telegram:dm:req",
          channel: "telegram",
        },
        target: {
          sessionKey: "agent:worker:main",
          displayKey: "agent:worker:main",
        },
        originalMessage: "Investigate the broker seam",
        announceTimeoutMs: 20_000,
        maxPingPongTurns: 1,
        waitRunId: "run-broker-1",
      },
      taskId: "run-broker-1",
      brokerTask: {
        id: "task-broker-terminal-1",
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
        status: "succeeded",
        message: "Investigate the broker seam",
        payload: {
          targetSessionKey: "agent:worker:main",
        },
        result: {
          summary: "Broker completed the delegation",
          note: "announce skipped on OpenClaw side",
          artifactIds: ["artifact-1"],
          output: {
            latestReply: "done",
          },
        },
        createdAt: "2026-04-14T00:00:00.000Z",
        claimedAt: "2026-04-14T00:00:10.000Z",
        completedAt: "2026-04-14T00:00:20.000Z",
        updatedAt: "2026-04-14T00:00:20.000Z",
      },
    });

    expect(record).toMatchObject({
      taskId: "task-broker-terminal-1",
      execution: {
        status: "completed",
      },
      delivery: {
        status: "skipped",
        mode: "announce",
      },
      result: {
        summary: "Broker completed the delegation",
        output: {
          latestReply: "done",
          note: "announce skipped on OpenClaw side",
          artifactIds: ["artifact-1"],
          status: "succeeded",
        },
      },
    });
  });

  it("maps standalone broker failures onto OpenClaw error fields", () => {
    const record = mapBrokerTaskRecordToOpenClawTaskRecord({
      request: {
        target: {
          sessionKey: "agent:worker:main",
          displayKey: "agent:worker:main",
        },
        originalMessage: "Investigate the broker failure",
        announceTimeoutMs: 20_000,
        maxPingPongTurns: 0,
        waitRunId: "run-broker-fail-1",
      },
      taskId: "run-broker-fail-1",
      brokerTask: {
        id: "task-broker-fail-1",
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
        status: "failed",
        message: "Investigate the broker failure",
        payload: {},
        error: {
          message: "worker failed to apply the patch",
        },
        createdAt: "2026-04-14T00:00:00.000Z",
        updatedAt: "2026-04-14T00:00:20.000Z",
        completedAt: "2026-04-14T00:00:20.000Z",
      },
    });

    expect(record).toMatchObject({
      execution: {
        status: "failed",
        errorCode: "remote_task_failed",
        errorMessage: "worker failed to apply the patch",
      },
      delivery: {
        status: "skipped",
      },
    });
  });

  it("subscribes to broker task events when standalone broker monitoring is enabled", async () => {
    const runTaskRequest = vi
      .fn()
      .mockResolvedValue(createAdapterTaskRecord("task-broker-stream-1"));
    const subscribeTaskStatus = vi.fn().mockResolvedValue({
      finalStatus: {
        taskId: "task-broker-stream-1",
        executionStatus: "completed",
        deliveryStatus: "skipped",
        updatedAt: 1,
        hasHeartbeat: true,
      } as never,
      endedReason: "terminal",
    });
    const reconcileTaskStatus = vi.fn();
    __testing.setAdapterSelectionForTest({
      createBrokerAdapter: () => ({
        runTaskRequest,
        subscribeTaskStatus,
        reconcileTaskStatus,
      }),
    });

    const record = await runSessionsSendA2AFlow({
      requesterSessionKey: "agent:main:telegram:dm:req",
      requesterChannel: "telegram",
      targetSessionKey: "agent:worker:main",
      displayKey: "agent:worker:main",
      message: "Monitor the broker stream",
      announceTimeoutMs: 20_000,
      maxPingPongTurns: 1,
      waitRunId: "run-broker-stream-1",
      followTaskStream: true,
      config: {
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
      } as never,
    });

    expect(record.taskId).toBe("task-broker-stream-1");
    expect(subscribeTaskStatus).toHaveBeenCalledWith({
      sessionKey: "agent:worker:main",
      taskId: "task-broker-stream-1",
    });
    expect(reconcileTaskStatus).not.toHaveBeenCalled();
  });

  it("falls back to reconcile when broker task streaming ends before a terminal status", async () => {
    const runTaskRequest = vi
      .fn()
      .mockResolvedValue(createAdapterTaskRecord("task-broker-stream-2"));
    const subscribeTaskStatus = vi.fn().mockResolvedValue({
      finalStatus: {
        taskId: "task-broker-stream-2",
        executionStatus: "running",
        deliveryStatus: "pending",
        updatedAt: 1,
        hasHeartbeat: true,
      } as never,
      endedReason: "stream_ended",
    });
    const reconcileTaskStatus = vi.fn().mockResolvedValue({
      taskId: "task-broker-stream-2",
      executionStatus: "running",
      deliveryStatus: "pending",
      updatedAt: 2,
      hasHeartbeat: true,
    } as never);
    __testing.setAdapterSelectionForTest({
      createBrokerAdapter: () => ({
        runTaskRequest,
        subscribeTaskStatus,
        reconcileTaskStatus,
      }),
    });

    await runSessionsSendA2AFlow({
      requesterSessionKey: "agent:main:telegram:dm:req",
      requesterChannel: "telegram",
      targetSessionKey: "agent:worker:main",
      displayKey: "agent:worker:main",
      message: "Recover from a short broker stream",
      announceTimeoutMs: 20_000,
      maxPingPongTurns: 1,
      waitRunId: "run-broker-stream-2",
      followTaskStream: true,
      config: {
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
      } as never,
    });

    expect(reconcileTaskStatus).toHaveBeenCalledWith({
      sessionKey: "agent:worker:main",
      taskId: "task-broker-stream-2",
    });
  });

  it("falls back to reconcile when broker task streaming throws", async () => {
    const runTaskRequest = vi
      .fn()
      .mockResolvedValue(createAdapterTaskRecord("task-broker-stream-3"));
    const subscribeTaskStatus = vi.fn().mockRejectedValue(new Error("stream failed"));
    const reconcileTaskStatus = vi.fn().mockResolvedValue({
      taskId: "task-broker-stream-3",
      executionStatus: "running",
      deliveryStatus: "pending",
      updatedAt: 3,
      hasHeartbeat: true,
    } as never);
    __testing.setAdapterSelectionForTest({
      createBrokerAdapter: () => ({
        runTaskRequest,
        subscribeTaskStatus,
        reconcileTaskStatus,
      }),
    });

    const record = await runSessionsSendA2AFlow({
      requesterSessionKey: "agent:main:telegram:dm:req",
      requesterChannel: "telegram",
      targetSessionKey: "agent:worker:main",
      displayKey: "agent:worker:main",
      message: "Recover from a broker stream error",
      announceTimeoutMs: 20_000,
      maxPingPongTurns: 1,
      waitRunId: "run-broker-stream-3",
      followTaskStream: true,
      config: {
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
      } as never,
    });

    expect(record.taskId).toBe("task-broker-stream-3");
    expect(reconcileTaskStatus).toHaveBeenCalledWith({
      sessionKey: "agent:worker:main",
      taskId: "task-broker-stream-3",
    });
  });
});

describe("trace propagation: correlationId, parentRunId, waitRunId, cancelTarget", () => {
  describe("buildSessionsSendA2AExchangeRequest", () => {
    it("preserves explicit correlationId even when waitRunId differs", () => {
      const req = __testing.buildTaskEnvelopeForTest({
        targetSessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
        message: "test",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-111",
        correlationId: "corr-aaa",
      });
      expect(req.trace?.correlationId).toBe("corr-aaa");
    });

    it("preserves explicit parentRunId even when waitRunId differs", () => {
      const req = __testing.buildTaskEnvelopeForTest({
        targetSessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
        message: "test",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-111",
        parentRunId: "parent-bbb",
      });
      expect(req.trace?.parentRunId).toBe("parent-bbb");
    });

    it("falls back correlationId and parentRunId to waitRunId when not provided", () => {
      const req = __testing.buildTaskEnvelopeForTest({
        targetSessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
        message: "test",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-222",
      });
      expect(req.trace?.correlationId).toBe("run-222");
      expect(req.trace?.parentRunId).toBe("run-222");
    });

    it("leaves trace undefined when no waitRunId/correlationId/parentRunId are set", () => {
      const req = __testing.buildTaskEnvelopeForTest({
        targetSessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
        message: "test",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
      });
      expect(req.trace?.correlationId).toBeUndefined();
      expect(req.trace?.parentRunId).toBeUndefined();
    });

    it("preserves explicit correlationId over waitRunId in envelope trace", () => {
      const req = __testing.buildTaskEnvelopeForTest({
        targetSessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
        message: "test",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-333",
        correlationId: "corr-unique",
        parentRunId: "parent-unique",
      });
      expect(req.trace?.correlationId).toBe("corr-unique");
      expect(req.trace?.parentRunId).toBe("parent-unique");
    });
  });

  describe("cancelTarget propagation", () => {
    it("uses explicit cancelTarget when provided", () => {
      const req = __testing.buildTaskEnvelopeForTest({
        targetSessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
        message: "test",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-444",
        cancelTarget: {
          kind: "session_run",
          sessionKey: "agent:other:session",
          runId: "custom-run-id",
        },
      });
      expect(req.runtime?.cancelTarget).toEqual({
        kind: "session_run",
        sessionKey: "agent:other:session",
        runId: "custom-run-id",
      });
    });

    it("auto-derives cancelTarget from targetSessionKey + waitRunId", () => {
      const req = __testing.buildTaskEnvelopeForTest({
        targetSessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
        message: "test",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-555",
      });
      expect(req.runtime?.cancelTarget).toEqual({
        kind: "session_run",
        sessionKey: "agent:worker:main",
        runId: "run-555",
      });
    });

    it("auto-derives cancelTarget without runId when waitRunId is absent", () => {
      const req = __testing.buildTaskEnvelopeForTest({
        targetSessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
        message: "test",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
      });
      expect(req.runtime?.cancelTarget).toEqual({
        kind: "session_run",
        sessionKey: "agent:worker:main",
      });
    });

    it("omits cancelTarget when targetSessionKey is empty", () => {
      const req = __testing.buildTaskEnvelopeForTest({
        targetSessionKey: "",
        displayKey: "",
        message: "test",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
      });
      expect(req.runtime?.cancelTarget).toEqual({ kind: "session_run", sessionKey: "" });
    });
  });

  describe("runSessionsSendA2AFlow propagates trace through adapter", () => {
    it("passes explicit correlationId and parentRunId through adapter request", async () => {
      const runTaskRequest = vi.fn().mockResolvedValue(createAdapterTaskRecord("task-trace-1"));
      __testing.setAdapterFactoryForTest(() => ({
        runTaskRequest,
      }));

      await runSessionsSendA2AFlow({
        targetSessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
        message: "trace check",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-600",
        correlationId: "corr-600",
        parentRunId: "parent-600",
      });

      const adapterCall = runTaskRequest.mock.calls[0][0];
      expect(adapterCall.request.correlationId).toBe("corr-600");
      expect(adapterCall.request.parentRunId).toBe("parent-600");
      expect(adapterCall.request.waitRunId).toBe("run-600");
    });

    it("passes explicit cancelTarget through adapter request", async () => {
      const runTaskRequest = vi.fn().mockResolvedValue(createAdapterTaskRecord("task-ct-1"));
      __testing.setAdapterFactoryForTest(() => ({
        runTaskRequest,
      }));

      const explicitCancel = {
        kind: "session_run" as const,
        sessionKey: "agent:cancel:target",
        runId: "cancel-run-123",
      };

      await runSessionsSendA2AFlow({
        targetSessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
        message: "cancel trace check",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-700",
        cancelTarget: explicitCancel,
      });

      const adapterCall = runTaskRequest.mock.calls[0][0];
      expect(adapterCall.request.cancelTarget).toEqual(explicitCancel);
    });

    it("does not let waitRunId fallback overwrite explicit correlationId", async () => {
      const runTaskRequest = vi
        .fn()
        .mockResolvedValue(createAdapterTaskRecord("task-no-overwrite"));
      __testing.setAdapterFactoryForTest(() => ({
        runTaskRequest,
      }));

      await runSessionsSendA2AFlow({
        targetSessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
        message: "overwrite check",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-different",
        correlationId: "corr-explicit",
        parentRunId: "parent-explicit",
      });

      const adapterCall = runTaskRequest.mock.calls[0][0];
      expect(adapterCall.request.correlationId).toBe("corr-explicit");
      expect(adapterCall.request.parentRunId).toBe("parent-explicit");
      expect(adapterCall.request.waitRunId).toBe("run-different");
    });
  });

  describe("cancelTarget stability across request path", () => {
    it("auto-derived cancelTarget runId matches waitRunId at request time", async () => {
      const runTaskRequest = vi.fn().mockResolvedValue(createAdapterTaskRecord("task-ct-auto"));
      __testing.setAdapterFactoryForTest(() => ({
        runTaskRequest,
      }));

      await runSessionsSendA2AFlow({
        targetSessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
        message: "auto cancel check",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-auto-999",
      });

      const adapterCall = runTaskRequest.mock.calls[0][0];
      expect(adapterCall.request.cancelTarget).toEqual({
        kind: "session_run",
        sessionKey: "agent:worker:main",
        runId: "run-auto-999",
      });
    });

    it("broker adapter selection preserves trace fields", async () => {
      const runTaskRequest = vi
        .fn()
        .mockResolvedValue(createAdapterTaskRecord("task-broker-trace"));
      __testing.setAdapterSelectionForTest({
        createBrokerAdapter: () => ({
          runTaskRequest,
        }),
      });

      await runSessionsSendA2AFlow({
        targetSessionKey: "agent:worker:main",
        displayKey: "agent:worker:main",
        message: "broker trace",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-broker-800",
        correlationId: "corr-broker-800",
        parentRunId: "parent-broker-800",
        config: {
          plugins: {
            entries: {
              "a2a-broker-adapter": {
                enabled: true,
                config: { baseUrl: "https://broker.example.com" },
              },
            },
          },
        } as never,
      });

      const adapterCall = runTaskRequest.mock.calls[0][0];
      expect(adapterCall.request.correlationId).toBe("corr-broker-800");
      expect(adapterCall.request.parentRunId).toBe("parent-broker-800");
      expect(adapterCall.request.cancelTarget).toEqual({
        kind: "session_run",
        sessionKey: "agent:worker:main",
        runId: "run-broker-800",
      });
    });
  });
});
