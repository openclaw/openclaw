import { describe, expect, it } from "vitest";
import { resolveNewSessionAgentId, shouldUseOptimisticNewSessionFallback } from "./app.ts";
import { GatewayRequestError } from "./gateway.ts";
import type { SessionsListResult } from "./types.ts";

function makeSessionsResult(keys: string[]): SessionsListResult {
  return {
    ts: 0,
    path: "sessions.json",
    count: keys.length,
    defaults: {
      modelProvider: null,
      model: null,
      contextTokens: null,
    },
    sessions: keys.map((key) => ({
      key,
      kind: "direct",
      updatedAt: 0,
    })),
  };
}

describe("shouldUseOptimisticNewSessionFallback", () => {
  it("allows fallback for transport errors", () => {
    expect(shouldUseOptimisticNewSessionFallback(new Error("gateway not connected"))).toBe(true);
  });

  it("allows fallback for unavailable gateway responses", () => {
    const error = new GatewayRequestError({
      code: "UNAVAILABLE",
      message: "temporary failure",
    });
    expect(shouldUseOptimisticNewSessionFallback(error)).toBe(true);
  });

  it("allows fallback for compatibility unknown-method failures", () => {
    const error = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "unknown method: sessions.create",
    });
    expect(shouldUseOptimisticNewSessionFallback(error)).toBe(true);
  });

  it("rejects fallback for authorization/scope failures", () => {
    const error = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "missing scope: operator.write",
    });
    expect(shouldUseOptimisticNewSessionFallback(error)).toBe(false);
  });
});

describe("resolveNewSessionAgentId", () => {
  it("uses agent id from active server-known session", () => {
    const agentId = resolveNewSessionAgentId({
      sessionKey: "agent:ops:dashboard:abc",
      sessionsResult: makeSessionsResult(["agent:ops:dashboard:abc"]),
      assistantAgentId: "main",
    });

    expect(agentId).toBe("ops");
  });

  it("ignores URL-injected unknown session keys and falls back to assistant agent", () => {
    const agentId = resolveNewSessionAgentId({
      sessionKey: "agent:victim:dashboard:evil",
      sessionsResult: makeSessionsResult(["agent:trusted:main"]),
      assistantAgentId: "trusted",
    });

    expect(agentId).toBe("trusted");
  });

  it("falls back to main when no trusted source is available", () => {
    const agentId = resolveNewSessionAgentId({
      sessionKey: "main",
      sessionsResult: null,
      assistantAgentId: null,
    });

    expect(agentId).toBe("main");
  });
});
