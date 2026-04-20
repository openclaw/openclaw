import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      tools: {
        sessions: { visibility: "all" },
      },
    }),
    resolveGatewayPort: () => 18789,
  };
});

import { createSessionsBroadcastTool } from "./sessions-broadcast-tool.js";

const makeSessionsListResponse = (
  sessions: Array<{
    key: string;
    kind?: string;
    channel?: string;
    lastChannel?: string;
  }>,
) => ({
  sessions,
  path: "/tmp/sessions.json",
});

describe("sessions_broadcast tool", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("broadcasts to multiple sessions and skips self", async () => {
    const agentKey = "agent:main:main";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string };
      if (req.method === "sessions.list") {
        return makeSessionsListResponse([
          { key: agentKey, kind: "direct", channel: "telegram" },
          { key: "agent:main:telegram:group:123", kind: "group", channel: "telegram" },
          { key: "agent:main:discord:group:456", kind: "group", channel: "discord" },
        ]);
      }
      if (req.method === "agent") {
        return { runId: "run-1" };
      }
      return {};
    });

    const tool = createSessionsBroadcastTool({
      agentSessionKey: agentKey,
      agentChannel: "telegram",
    });

    const result = await tool.execute("call-1", { message: "System update ready" });
    const details = result.details as {
      status?: string;
      sent?: number;
      sessions?: string[];
    };

    expect(details.status).toBe("ok");
    // Self is excluded, so only 2 sessions should receive the broadcast
    expect(details.sent).toBe(2);
    expect(details.sessions).toHaveLength(2);

    // Verify self was not broadcast to
    const agentCalls = callGatewayMock.mock.calls.filter(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    const targets = agentCalls.map(
      (call) => (call[0] as { params?: { sessionKey?: string } }).params?.sessionKey,
    );
    expect(targets).not.toContain(agentKey);
  });

  it("skips the current session (does not broadcast to self)", async () => {
    const selfKey = "agent:main:main";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string };
      if (req.method === "sessions.list") {
        return makeSessionsListResponse([{ key: selfKey, kind: "direct", channel: "telegram" }]);
      }
      return {};
    });

    const tool = createSessionsBroadcastTool({ agentSessionKey: selfKey });

    const result = await tool.execute("call-2", { message: "hello" });
    const details = result.details as { status?: string; sent?: number; sessions?: string[] };

    expect(details.status).toBe("ok");
    expect(details.sent).toBe(0);
    expect(details.sessions).toHaveLength(0);

    // No agent calls should have been made
    const agentCalls = callGatewayMock.mock.calls.filter(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    expect(agentCalls).toHaveLength(0);
  });

  it("scope filtering only sends to matching channel sessions", async () => {
    const selfKey = "agent:main:main";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string };
      if (req.method === "sessions.list") {
        return makeSessionsListResponse([
          { key: selfKey, kind: "direct", channel: "telegram" },
          { key: "agent:main:telegram:group:111", kind: "group", channel: "telegram" },
          { key: "agent:main:discord:group:222", kind: "group", channel: "discord" },
          { key: "agent:main:whatsapp:group:333", kind: "group", channel: "whatsapp" },
        ]);
      }
      if (req.method === "agent") {
        return { runId: "run-scope" };
      }
      return {};
    });

    const tool = createSessionsBroadcastTool({ agentSessionKey: selfKey });

    // Broadcast only to discord
    const result = await tool.execute("call-3", {
      message: "discord only",
      scope: "discord",
    });
    const details = result.details as { status?: string; sent?: number; sessions?: string[] };

    expect(details.status).toBe("ok");
    expect(details.sent).toBe(1);

    const agentCalls = callGatewayMock.mock.calls.filter(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]?.[0]).toMatchObject({
      method: "agent",
      params: {
        sessionKey: "agent:main:discord:group:222",
      },
    });
  });

  it("returns correct count and session list", async () => {
    const selfKey = "agent:main:main";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string };
      if (req.method === "sessions.list") {
        return makeSessionsListResponse([
          { key: selfKey, kind: "direct", channel: "telegram" },
          { key: "agent:main:telegram:group:aaa", kind: "group", channel: "telegram" },
          { key: "agent:main:telegram:group:bbb", kind: "group", channel: "telegram" },
          { key: "agent:main:telegram:group:ccc", kind: "group", channel: "telegram" },
        ]);
      }
      if (req.method === "agent") {
        return { runId: "run-count" };
      }
      return {};
    });

    const tool = createSessionsBroadcastTool({ agentSessionKey: selfKey });

    const result = await tool.execute("call-4", { message: "count me" });
    const details = result.details as { status?: string; sent?: number; sessions?: string[] };

    expect(details.status).toBe("ok");
    expect(details.sent).toBe(3);
    expect(details.sessions).toHaveLength(3);
  });

  it("uses INTERNAL_MESSAGE_CHANNEL and fire-and-forget lane for all sends", async () => {
    const selfKey = "agent:main:main";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string };
      if (req.method === "sessions.list") {
        return makeSessionsListResponse([
          { key: selfKey, kind: "direct", channel: "telegram" },
          { key: "agent:main:telegram:group:x", kind: "group", channel: "telegram" },
        ]);
      }
      if (req.method === "agent") {
        return { runId: "run-ff" };
      }
      return {};
    });

    const tool = createSessionsBroadcastTool({
      agentSessionKey: selfKey,
      agentChannel: "telegram",
    });

    await tool.execute("call-5", { message: "fire and forget" });

    const agentCalls = callGatewayMock.mock.calls.filter(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]?.[0]).toMatchObject({
      method: "agent",
      params: {
        channel: "webchat",
        lane: "nested",
        deliver: false,
        inputProvenance: {
          kind: "broadcast",
          sourceTool: "sessions_broadcast",
        },
      },
    });
  });

  it("returns empty result when no sessions exist besides self", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string };
      if (req.method === "sessions.list") {
        return makeSessionsListResponse([]);
      }
      return {};
    });

    const tool = createSessionsBroadcastTool({ agentSessionKey: "agent:main:main" });

    const result = await tool.execute("call-6", { message: "nobody home" });
    const details = result.details as {
      status?: string;
      sent?: number;
      sessions?: string[];
      message?: string;
    };

    expect(details.status).toBe("ok");
    expect(details.sent).toBe(0);
    expect(details.message).toBe("No sessions to broadcast to.");
  });
});
