import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCallGateway = vi.fn();
const mockListPendingRequestsForChild = vi.fn();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => mockCallGateway(opts),
}));

vi.mock("../orchestrator-request-registry.js", () => ({
  listPendingRequestsForChild: (...args: unknown[]) => mockListPendingRequestsForChild(...args),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      session: {
        mainKey: "main",
        scope: "per-sender",
        agentToAgent: { maxPingPongTurns: 2 },
      },
      tools: {
        sessions: { visibility: "all" },
      },
    }),
    resolveGatewayPort: () => 18789,
  };
});

import { createSessionsListTool } from "./sessions-list-tool.js";

describe("Status projection in list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes runStatus in session rows when requests pending", async () => {
    // Setup: mock gateway to return a session row
    mockCallGateway.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:subagent:child-1",
              kind: "direct",
              sessionId: "sess-child-1",
              updatedAt: 1000,
            },
          ],
        };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    // Setup: mock orchestrator registry to return pending requests
    mockListPendingRequestsForChild.mockReturnValue([
      {
        requestId: "req_1",
        childSessionKey: "agent:main:subagent:child-1",
        parentSessionKey: "agent:main:main",
        message: "need help",
        status: "pending",
        createdAt: Date.now(),
        timeoutAt: Date.now() + 300_000,
      },
    ]);

    const tool = createSessionsListTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", {});
    const details = result.details as { sessions?: Array<Record<string, unknown>> };
    const session = details.sessions?.[0];

    expect(session?.runStatus).toBe("blocked");
  });

  it("includes blockedReason as awaiting_orchestrator", async () => {
    mockCallGateway.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:subagent:child-1",
              kind: "direct",
              sessionId: "sess-child-1",
              updatedAt: 1000,
            },
          ],
        };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    mockListPendingRequestsForChild.mockReturnValue([
      {
        requestId: "req_1",
        childSessionKey: "agent:main:subagent:child-1",
        parentSessionKey: "agent:main:main",
        message: "need help",
        status: "pending",
        createdAt: Date.now(),
        timeoutAt: Date.now() + 300_000,
      },
    ]);

    const tool = createSessionsListTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call2", {});
    const details = result.details as { sessions?: Array<Record<string, unknown>> };
    const session = details.sessions?.[0];

    expect(session?.blockedReason).toBe("awaiting_orchestrator");
  });

  it("includes pendingRequestCount", async () => {
    mockCallGateway.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:subagent:child-1",
              kind: "direct",
              sessionId: "sess-child-1",
              updatedAt: 1000,
            },
          ],
        };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    // Return 2 pending requests
    mockListPendingRequestsForChild.mockReturnValue([
      {
        requestId: "req_1",
        childSessionKey: "agent:main:subagent:child-1",
        parentSessionKey: "agent:main:main",
        message: "need help 1",
        status: "pending",
        createdAt: Date.now(),
        timeoutAt: Date.now() + 300_000,
      },
      {
        requestId: "req_2",
        childSessionKey: "agent:main:subagent:child-1",
        parentSessionKey: "agent:main:main",
        message: "need help 2",
        status: "notified",
        createdAt: Date.now(),
        timeoutAt: Date.now() + 300_000,
      },
    ]);

    const tool = createSessionsListTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call3", {});
    const details = result.details as { sessions?: Array<Record<string, unknown>> };
    const session = details.sessions?.[0];

    expect(session?.pendingRequestCount).toBe(2);
  });

  it("does not include status fields when no pending requests", async () => {
    mockCallGateway.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:subagent:child-1",
              kind: "direct",
              sessionId: "sess-child-1",
              updatedAt: 1000,
            },
          ],
        };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    // No pending requests
    mockListPendingRequestsForChild.mockReturnValue([]);

    const tool = createSessionsListTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call4", {});
    const details = result.details as { sessions?: Array<Record<string, unknown>> };
    const session = details.sessions?.[0];

    expect(session?.runStatus).toBeUndefined();
    expect(session?.blockedReason).toBeUndefined();
    expect(session?.pendingRequestCount).toBeUndefined();
  });
});
