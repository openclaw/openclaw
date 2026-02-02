import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
const abortEmbeddedPiRunMock = vi.fn();
const clearSessionQueuesMock = vi.fn();
const loadSessionStoreMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const listSubagentRunsForRequesterMock = vi.fn();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../pi-embedded.js", () => ({
  abortEmbeddedPiRun: (sessionId: string) => abortEmbeddedPiRunMock(sessionId),
}));

vi.mock("../../auto-reply/reply/queue.js", () => ({
  clearSessionQueues: (keys: string[]) => clearSessionQueuesMock(keys),
}));

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: (path: string) => loadSessionStoreMock(path),
  updateSessionStore: (path: string, fn: unknown) => updateSessionStoreMock(path, fn),
  resolveStorePath: () => "/tmp/sessions.json",
}));

vi.mock("../subagent-registry.js", () => ({
  listSubagentRunsForRequester: (key: string) => listSubagentRunsForRequesterMock(key),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () =>
      ({
        session: { scope: "per-sender", mainKey: "main" },
        agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
        tools: { agentToAgent: { enabled: false } },
      }) as never,
  };
});

import { createSessionsStopTool } from "./sessions-stop-tool.js";

describe("sessions_stop tool", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    abortEmbeddedPiRunMock.mockReset();
    clearSessionQueuesMock.mockReset();
    loadSessionStoreMock.mockReset();
    updateSessionStoreMock.mockReset();
    listSubagentRunsForRequesterMock.mockReset();

    // Default mock implementations
    clearSessionQueuesMock.mockReturnValue({
      followupCleared: 0,
      laneCleared: 0,
      keys: [],
    });
    loadSessionStoreMock.mockReturnValue({});
    updateSessionStoreMock.mockResolvedValue(undefined);
    listSubagentRunsForRequesterMock.mockReturnValue([]);
  });

  it("blocks cross-agent stops when tools.agentToAgent.enabled is false", async () => {
    const tool = createSessionsStopTool({
      agentSessionKey: "agent:main:main",
    });

    loadSessionStoreMock.mockReturnValue({
      "agent:other:main": {
        sessionId: "session-123",
        updatedAt: Date.now(),
      },
    });

    const result = await tool.execute("call1", {
      sessionKey: "agent:other:main",
    });

    expect(abortEmbeddedPiRunMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ status: "forbidden" });
  });

  it("allows same-agent stops", async () => {
    const tool = createSessionsStopTool({
      agentSessionKey: "agent:main:main",
    });

    loadSessionStoreMock.mockReturnValue({
      "agent:main:subagent:abc-123": {
        sessionId: "session-456",
        updatedAt: Date.now(),
      },
    });

    abortEmbeddedPiRunMock.mockReturnValue(true);
    clearSessionQueuesMock.mockReturnValue({
      followupCleared: 1,
      laneCleared: 0,
      keys: ["agent:main:subagent:abc-123"],
    });

    const result = await tool.execute("call1", {
      sessionKey: "agent:main:subagent:abc-123",
    });

    expect(abortEmbeddedPiRunMock).toHaveBeenCalledWith("session-456");
    expect(clearSessionQueuesMock).toHaveBeenCalledWith(
      expect.arrayContaining(["agent:main:subagent:abc-123", "session-456"]),
    );
    expect(result.details).toMatchObject({
      status: "ok",
      aborted: true,
      clearedFollowups: 1,
      clearedLane: 0,
    });
  });

  it("handles sessions without sessionId", async () => {
    const tool = createSessionsStopTool({
      agentSessionKey: "agent:main:main",
    });

    loadSessionStoreMock.mockReturnValue({
      "agent:main:subagent:xyz-789": {
        // No sessionId
        updatedAt: Date.now(),
      },
    });

    clearSessionQueuesMock.mockReturnValue({
      followupCleared: 0,
      laneCleared: 1,
      keys: ["agent:main:subagent:xyz-789"],
    });

    const result = await tool.execute("call1", {
      sessionKey: "agent:main:subagent:xyz-789",
    });

    expect(abortEmbeddedPiRunMock).not.toHaveBeenCalled();
    expect(clearSessionQueuesMock).toHaveBeenCalledWith(["agent:main:subagent:xyz-789"]);
    expect(result.details).toMatchObject({
      status: "ok",
      aborted: true,
      clearedLane: 1,
    });
  });

  it("respects sandboxed spawned-only visibility", async () => {
    const tool = createSessionsStopTool({
      agentSessionKey: "agent:main:main",
      sandboxed: true,
    });

    // Session exists but not spawned by requester
    loadSessionStoreMock.mockReturnValue({
      "agent:main:other-session": {
        sessionId: "session-999",
        updatedAt: Date.now(),
      },
    });

    listSubagentRunsForRequesterMock.mockReturnValue([]);

    const result = await tool.execute("call1", {
      sessionKey: "agent:main:other-session",
    });

    expect(abortEmbeddedPiRunMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ status: "forbidden" });
  });

  it("allows sandboxed agents to stop their spawned subagents", async () => {
    const tool = createSessionsStopTool({
      agentSessionKey: "agent:main:main",
      sandboxed: true,
    });

    loadSessionStoreMock.mockReturnValue({
      "agent:main:subagent:abc-123": {
        sessionId: "session-456",
        updatedAt: Date.now(),
      },
    });

    listSubagentRunsForRequesterMock.mockReturnValue([
      {
        childSessionKey: "agent:main:subagent:abc-123",
        runId: "run-123",
        requesterSessionKey: "agent:main:main",
      },
    ]);

    abortEmbeddedPiRunMock.mockReturnValue(true);
    clearSessionQueuesMock.mockReturnValue({
      followupCleared: 0,
      laneCleared: 1,
      keys: ["agent:main:subagent:abc-123"],
    });

    const result = await tool.execute("call1", {
      sessionKey: "agent:main:subagent:abc-123",
    });

    expect(abortEmbeddedPiRunMock).toHaveBeenCalledWith("session-456");
    expect(result.details).toMatchObject({
      status: "ok",
      aborted: true,
    });
  });
});
