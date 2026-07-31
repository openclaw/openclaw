import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const gatewayCall = vi.fn();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (request: unknown) => gatewayCall(request),
}));

vi.mock("./sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: vi.fn(),
}));

let createSessionsSendTool: typeof import("./sessions-send-tool.js").createSessionsSendTool;

beforeAll(async () => {
  ({ createSessionsSendTool } = await import("./sessions-send-tool.js"));
});

beforeEach(() => {
  gatewayCall.mockReset();
});

function createTool(options: { a2aEnabled?: boolean; agentId?: string } = {}) {
  const agentId = options.agentId ?? "main";
  return createSessionsSendTool({
    agentId,
    agentSessionKey: `agent:${agentId}:main`,
    config: {
      agents: { ownership: "explicit", entries: { main: {}, other: {} } },
      tools: {
        agentToAgent: { enabled: options.a2aEnabled ?? false },
        sessions: { visibility: "all" },
      },
    },
  });
}

function details(result: { details?: unknown }) {
  if (!result.details || typeof result.details !== "object") {
    throw new Error("expected sessions_send details");
  }
  return result.details as Record<string, unknown>;
}

describe("sessions_send resolved-owner authorization", () => {
  it("denies a bare key resolved to another agent when A2A is disabled", async () => {
    gatewayCall.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return { key: "incident-42", agentId: "other" };
      }
      return {};
    });

    const result = await createTool().execute("cross-agent-bare", {
      sessionKey: "b0d79b63-0f73-4bc9-a6b5-6d8e20f42c3c",
      message: "status?",
      timeoutSeconds: 0,
    });

    expect(details(result)).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("Agent-to-agent messaging is disabled"),
    });
    expect(gatewayCall).not.toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });

  it("allows a bare key resolved to the requester agent", async () => {
    gatewayCall.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return { key: "incident-42", agentId: "main" };
      }
      if (request.method === "agent") {
        return { runId: "run-same-agent", acceptedAt: 1 };
      }
      return {};
    });

    const result = await createTool().execute("same-agent-bare", {
      sessionKey: "b0d79b63-0f73-4bc9-a6b5-6d8e20f42c3c",
      message: "status?",
      timeoutSeconds: 0,
    });

    expect(details(result).status).toBe("accepted");
    expect(gatewayCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({ agentId: "main", sessionKey: "incident-42" }),
      }),
    );
  });

  it("fails closed when an older gateway omits the owner of a bare key", async () => {
    gatewayCall.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return { key: "incident-42" };
      }
      return {};
    });

    const result = await createTool({ agentId: "other" }).execute("ownerless-bare", {
      sessionKey: "b0d79b63-0f73-4bc9-a6b5-6d8e20f42c3c",
      message: "status?",
      timeoutSeconds: 0,
    });

    expect(details(result)).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("ownership could not be verified"),
    });
    expect(gatewayCall).not.toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });

  it("fails closed when an older gateway resolves a session id to an ownerless sentinel", async () => {
    gatewayCall.mockImplementation(
      async (request: { method?: string; params?: { key?: string; sessionId?: string } }) => {
        if (request.method !== "sessions.resolve") {
          return {};
        }
        if (request.params?.key) {
          throw new Error("not a session key");
        }
        if (request.params?.sessionId) {
          return { key: "global" };
        }
        return {};
      },
    );

    const result = await createTool({ agentId: "other" }).execute("ownerless-id-sentinel", {
      sessionKey: "b0d79b63-0f73-4bc9-a6b5-6d8e20f42c3c",
      message: "status?",
      timeoutSeconds: 0,
    });

    expect(details(result)).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("Upgrade the gateway"),
    });
    expect(gatewayCall).not.toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });

  it("keeps requester ownership for a literal global sentinel", async () => {
    gatewayCall.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        return { runId: "literal-global", acceptedAt: 1 };
      }
      return {};
    });

    const result = await createTool({ agentId: "other" }).execute("literal-global", {
      sessionKey: "global",
      message: "status?",
      timeoutSeconds: 0,
    });

    expect(details(result).status).toBe("accepted");
    expect(gatewayCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({ agentId: "other", sessionKey: "global" }),
      }),
    );
  });

  it("does not invent requester ownership when a label resolves to an ownerless sentinel", async () => {
    gatewayCall.mockImplementation(
      async (request: { method?: string; params?: { label?: string } }) => {
        if (request.method === "sessions.resolve" && request.params?.label) {
          return { key: "global" };
        }
        return {};
      },
    );

    const result = await createTool({ agentId: "other" }).execute("ownerless-label-sentinel", {
      label: "incident-room",
      message: "status?",
      timeoutSeconds: 0,
    });

    expect(details(result)).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("target agent ownership is unavailable"),
    });
    expect(gatewayCall).not.toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });

  it("does not trust a caller-supplied agent for an ownerless bare key", async () => {
    gatewayCall.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return { key: "incident-42" };
      }
      return {};
    });

    const result = await createTool({ agentId: "other" }).execute("ownerless-bare-agent", {
      sessionKey: "b0d79b63-0f73-4bc9-a6b5-6d8e20f42c3c",
      agentId: "other",
      message: "status?",
      timeoutSeconds: 0,
    });

    expect(details(result)).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("ownership could not be verified"),
    });
    expect(gatewayCall).not.toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });

  it("keeps an owned global sentinel subject to cross-agent policy", async () => {
    gatewayCall.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return { key: "global", agentId: "other" };
      }
      return {};
    });

    const result = await createTool().execute("cross-agent-global", {
      sessionKey: "b0d79b63-0f73-4bc9-a6b5-6d8e20f42c3c",
      message: "status?",
      timeoutSeconds: 0,
    });

    expect(details(result)).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("Agent-to-agent messaging is disabled"),
    });
  });

  it("denies a malformed agent-prefixed key owned by another agent", async () => {
    gatewayCall.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return { key: "agent:broken", agentId: "other" };
      }
      return {};
    });

    const result = await createTool().execute("cross-agent-malformed", {
      sessionKey: "d8b7b15b-fc10-4a9b-810b-e65e7ed2c3b0",
      message: "status?",
      timeoutSeconds: 0,
    });

    expect(details(result)).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("Agent-to-agent messaging is disabled"),
    });
    expect(gatewayCall).not.toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });

  it("carries a bare main session owner through resolve and create", async () => {
    gatewayCall.mockImplementation(
      async (request: { method?: string; params?: { agentId?: string } }) => {
        if (request.method === "sessions.resolve" && request.params?.agentId === "other") {
          throw new Error("missing");
        }
        if (request.method === "sessions.resolve") {
          return { key: "main", agentId: "other" };
        }
        if (request.method === "sessions.create") {
          return { key: "main", agentId: "other" };
        }
        if (request.method === "agent") {
          return { runId: "run-other-main", acceptedAt: 1 };
        }
        return {};
      },
    );

    const result = await createTool({ a2aEnabled: true }).execute("other-main", {
      sessionKey: "33c37740-d450-44d1-90f6-abbdd4aabf88",
      message: "status?",
      timeoutSeconds: 0,
    });

    expect(details(result).status).toBe("accepted");
    expect(gatewayCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.resolve",
        params: { key: "main", agentId: "other" },
      }),
    );
    expect(gatewayCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.create",
        params: { key: "main", agentId: "other" },
      }),
    );
  });
});
