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
});
