import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const scheduleSessionsGraphMock = vi.fn();
  return {
    scheduleSessionsGraphMock,
  };
});

vi.mock("../sessions-schedule.js", () => ({
  scheduleSessionsGraph: (...args: unknown[]) => hoisted.scheduleSessionsGraphMock(...args),
}));

vi.mock("../subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
}));

vi.mock("../acp-spawn.js", () => ({
  ACP_SPAWN_MODES: ["run", "session"],
  ACP_SPAWN_STREAM_TARGETS: ["parent"],
}));

const { createSessionsScheduleTool } = await import("./sessions-schedule-tool.js");

describe("sessions_schedule tool", () => {
  beforeEach(() => {
    hoisted.scheduleSessionsGraphMock.mockReset().mockResolvedValue({
      status: "accepted",
      scheduleId: "schedule-1",
      startedNodeIds: ["frontend"],
      summary: {
        pending: 1,
        ready: 0,
        running: 1,
        completed: 0,
        failed: 0,
        blocked: 0,
      },
      nodes: [],
      note: "ok",
    });
  });

  it("passes graph nodes, dependencies, and context through to the scheduler", async () => {
    const tool = createSessionsScheduleTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
      agentAccountId: "default",
      agentTo: "channel:123",
      agentThreadId: "456",
      requesterAgentIdOverride: "bobby-digital",
      workspaceDir: "/workspace",
    });

    const result = await tool.execute("call-1", {
      nodes: [
        {
          id: "frontend",
          task: "Implement the UI",
          teamId: "frontend",
          capability: "frontend",
        },
      ],
      dependencies: [],
      maxParallel: 3,
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      scheduleId: "schedule-1",
    });
    expect(hoisted.scheduleSessionsGraphMock).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: [
          expect.objectContaining({
            id: "frontend",
            teamId: "frontend",
            capability: "frontend",
          }),
        ],
        maxParallel: 3,
        context: expect.objectContaining({
          agentSessionKey: "agent:main:main",
          requesterAgentIdOverride: "bobby-digital",
          workspaceDir: "/workspace",
        }),
      }),
    );
  });

  it("rejects invalid mixed selectors before scheduling", async () => {
    const tool = createSessionsScheduleTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-2", {
      nodes: [
        {
          id: "frontend",
          task: "Implement the UI",
          agentId: "method-man",
          teamId: "frontend",
          capability: "frontend",
        },
      ],
    });

    expect(JSON.stringify(result)).toContain(
      "agentId cannot be combined with teamId/capability/role",
    );
    expect(hoisted.scheduleSessionsGraphMock).not.toHaveBeenCalled();
  });
});
