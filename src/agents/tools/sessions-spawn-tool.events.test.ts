import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCallGateway = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => mockCallGateway(...args),
}));

const mockEmit = vi.fn();
vi.mock("../../infra/events/bus.js", () => ({
  emit: (...args: unknown[]) => mockEmit(...args),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      session: { mainKey: "main", scope: "per-sender" },
    }),
  };
});

vi.mock("../agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => ({
    subagents: {
      allowAgents: ["*"],
    },
  })),
  resolveAgentModelPrimary: vi.fn(() => undefined),
  resolveAgentEffectiveModelPrimary: vi.fn(() => undefined),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace-planner"),
}));

vi.mock("../lanes.js", () => ({
  AGENT_LANE_SUBAGENT: "subagent",
}));

vi.mock("../subagent-announce.js", () => ({
  buildSubagentSystemPrompt: vi.fn(() => "subagent-system-prompt"),
}));

const mockRegisterSubagentRun = vi.fn();
vi.mock("../subagent-registry.js", () => ({
  countActiveRunsForSession: vi.fn().mockReturnValue(0),
  registerSubagentRun: (...args: unknown[]) => mockRegisterSubagentRun(...args),
}));

vi.mock("./task-tool.js", () => ({
  readCurrentTaskId: vi.fn(async () => null),
  readTask: vi.fn(async () => null),
}));

import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";

describe("sessions_spawn collaboration events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits spawn + send + spawn_result(accepted) with shared conversationId", async () => {
    mockCallGateway.mockImplementation(async (request: { method?: string }) =>
      request?.method === "agent" ? { runId: "run-123" } : {},
    );

    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:planner:main",
    });

    const result = await tool.execute("call-1", {
      task: "Review this implementation",
      taskId: "task_abc123",
      workSessionId: "ws-demo-1",
      parentConversationId: "conv-parent-1",
      depth: 1,
      hop: 2,
      agentId: "worker-deep",
      cleanup: "keep",
    });

    expect((result as { details?: { status?: string } }).details?.status).toBe("accepted");
    expect(mockCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          lane: "subagent",
          message: expect.stringContaining("Review this implementation"),
        }),
      }),
    );

    const events = mockEmit.mock.calls.map(
      (call: unknown[]) => call[0] as { type?: string; data?: Record<string, unknown> },
    );
    const spawnEvent = events.find((event) => event.type === "a2a.spawn");
    const sendEvent = events.find((event) => event.type === "a2a.send");
    const spawnResult = events.find((event) => event.type === "a2a.spawn_result");

    expect(spawnEvent).toBeDefined();
    expect(sendEvent).toBeDefined();
    expect(spawnResult).toBeDefined();

    expect(spawnEvent?.data?.fromAgent).toBe("planner");
    expect(spawnEvent?.data?.toAgent).toBe("worker-deep");
    expect(typeof spawnEvent?.data?.conversationId).toBe("string");
    expect(spawnEvent?.data?.conversationId).toBe("conv-parent-1");
    expect(sendEvent?.data?.conversationId).toBe("conv-parent-1");
    expect(spawnResult?.data?.conversationId).toBe("conv-parent-1");
    expect(spawnEvent?.data?.workSessionId).toBe("ws-demo-1");
    expect(sendEvent?.data?.workSessionId).toBe("ws-demo-1");
    expect(spawnResult?.data?.workSessionId).toBe("ws-demo-1");
    expect(spawnEvent?.data?.taskId).toBe("task_abc123");
    expect(spawnEvent?.data?.depth).toBe(1);
    expect(spawnEvent?.data?.hop).toBe(2);

    expect(spawnResult?.data?.status).toBe("accepted");
    expect(spawnResult?.data?.runId).toBe("run-123");

    expect(mockRegisterSubagentRun).toHaveBeenCalledTimes(1);
    expect(mockRegisterSubagentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-123",
        conversationId: spawnEvent?.data?.conversationId,
        parentConversationId: "conv-parent-1",
        taskId: "task_abc123",
        workSessionId: "ws-demo-1",
        depth: 1,
        hop: 2,
        requesterAgentId: "planner",
        targetAgentId: "worker-deep",
      }),
    );
  });

  it("emits spawn_result(error) when child run dispatch fails", async () => {
    mockCallGateway.mockImplementation(async (request: { method?: string }) => {
      if (request?.method === "agent") {
        throw new Error("gateway unavailable");
      }
      return {};
    });

    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:planner:main",
    });

    const result = await tool.execute("call-2", {
      task: "Dispatch this task",
      agentId: "worker-quick",
    });

    expect((result as { details?: { status?: string } }).details?.status).toBe("error");

    const spawnResult = mockEmit.mock.calls.find(
      (call: unknown[]) => (call[0] as { type?: string }).type === "a2a.spawn_result",
    )?.[0] as { data?: Record<string, unknown> } | undefined;

    expect(spawnResult).toBeDefined();
    expect(spawnResult?.data?.status).toBe("error");
    expect(spawnResult?.data?.error).toBe("gateway unavailable");
    expect(mockRegisterSubagentRun).not.toHaveBeenCalled();
  });
});
