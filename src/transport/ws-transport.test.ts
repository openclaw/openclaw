import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock callGateway ───────────────────────────────────────────

const callGatewayMock = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

// ── Imports (after mock) ───────────────────────────────────────

import { createTransport } from "./factory.js";
import { WebSocketTransport } from "./ws-transport.js";

// ── Helpers ────────────────────────────────────────────────────

function makeMessage(overrides?: Record<string, unknown>) {
  return {
    sessionKey: "agent:main:subagent:test-123",
    message: "do something",
    runId: "run-abc",
    ...(overrides ?? {}),
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe("WebSocketTransport", () => {
  let transport: WebSocketTransport;

  beforeEach(() => {
    callGatewayMock.mockReset();
    transport = new WebSocketTransport();
  });

  // ── send ───────────────────────────────────────────────────

  describe("send()", () => {
    it("calls callGateway with method 'agent' and correct params", async () => {
      callGatewayMock.mockResolvedValue({ runId: "run-abc", status: "accepted" });

      const result = await transport.send(makeMessage());

      expect(callGatewayMock).toHaveBeenCalledTimes(1);
      const call = callGatewayMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call.method).toBe("agent");

      const params = call.params as Record<string, unknown>;
      expect(params.message).toBe("do something");
      expect(params.sessionKey).toBe("agent:main:subagent:test-123");
      expect(params.deliver).toBe(false);
      expect(typeof params.idempotencyKey).toBe("string");

      expect(result).toEqual({ runId: "run-abc", status: "accepted" });
    });

    it("uses msg.runId as idempotency key when provided", async () => {
      callGatewayMock.mockResolvedValue({ runId: "run-abc" });

      await transport.send(makeMessage({ runId: "custom-id" }));

      const params = (callGatewayMock.mock.calls[0]?.[0] as Record<string, unknown>)
        .params as Record<string, unknown>;
      expect(params.idempotencyKey).toBe("custom-id");
    });

    it("spreads metadata into params", async () => {
      callGatewayMock.mockResolvedValue({ runId: "run-abc" });

      await transport.send(
        makeMessage({ metadata: { agentId: "beta", thinking: "low" } }),
      );

      const params = (callGatewayMock.mock.calls[0]?.[0] as Record<string, unknown>)
        .params as Record<string, unknown>;
      expect(params.agentId).toBe("beta");
      expect(params.thinking).toBe("low");
    });
  });

  // ── sendAndWait ────────────────────────────────────────────

  describe("sendAndWait()", () => {
    it("sends then waits via agent.wait", async () => {
      callGatewayMock
        .mockResolvedValueOnce({ runId: "run-1", status: "accepted" }) // send
        .mockResolvedValueOnce({
          status: "ok",
          reply: "done",
          startedAt: 1000,
          endedAt: 2000,
        }); // wait

      const reply = await transport.sendAndWait(makeMessage({ runId: "run-1" }), 30_000);

      expect(callGatewayMock).toHaveBeenCalledTimes(2);

      // First call = agent (send)
      const sendCall = callGatewayMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sendCall.method).toBe("agent");

      // Second call = agent.wait
      const waitCall = callGatewayMock.mock.calls[1]?.[0] as Record<string, unknown>;
      expect(waitCall.method).toBe("agent.wait");

      const waitParams = waitCall.params as Record<string, unknown>;
      expect(waitParams.runId).toBe("run-1");
      expect(waitParams.timeoutMs).toBe(30_000);

      expect(reply.status).toBe("ok");
      expect(reply.reply).toBe("done");
      expect(reply.runId).toBe("run-1");
    });
  });

  // ── resolveSession ─────────────────────────────────────────

  describe("resolveSession()", () => {
    it("calls sessions.resolve with label", async () => {
      callGatewayMock.mockResolvedValue({ key: "agent:main:subagent:resolved" });

      const result = await transport.resolveSession({ label: "my-task" });

      expect(callGatewayMock).toHaveBeenCalledTimes(1);
      const call = callGatewayMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call.method).toBe("sessions.resolve");

      const params = call.params as Record<string, unknown>;
      expect(params.label).toBe("my-task");

      expect(result).toEqual({ key: "agent:main:subagent:resolved" });
    });

    it("throws when sessions.resolve returns empty key", async () => {
      callGatewayMock.mockResolvedValue({ key: "" });

      await expect(transport.resolveSession({ label: "missing" })).rejects.toThrow(
        "sessions.resolve returned an empty key",
      );
    });

    it("passes sessionId when provided", async () => {
      callGatewayMock.mockResolvedValue({ key: "agent:main:sess-123" });

      await transport.resolveSession({ sessionId: "sess-123" });

      const params = (callGatewayMock.mock.calls[0]?.[0] as Record<string, unknown>)
        .params as Record<string, unknown>;
      expect(params.sessionId).toBe("sess-123");
    });
  });

  // ── waitForRun ─────────────────────────────────────────────

  describe("waitForRun()", () => {
    it("calls agent.wait with transport-level timeout margin", async () => {
      callGatewayMock.mockResolvedValue({
        status: "ok",
        reply: "result text",
        startedAt: 100,
        endedAt: 200,
      });

      const reply = await transport.waitForRun("run-99", 15_000);

      const call = callGatewayMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call.method).toBe("agent.wait");
      expect(call.timeoutMs).toBe(25_000); // 15000 + 10000 margin

      const params = call.params as Record<string, unknown>;
      expect(params.runId).toBe("run-99");
      expect(params.timeoutMs).toBe(15_000);

      expect(reply).toEqual({
        runId: "run-99",
        status: "ok",
        reply: "result text",
        error: undefined,
        startedAt: 100,
        endedAt: 200,
      });
    });

    it("normalizes timeout status", async () => {
      callGatewayMock.mockResolvedValue({
        status: "timeout",
        error: "run did not finish",
      });

      const reply = await transport.waitForRun("run-slow", 5_000);

      expect(reply.status).toBe("timeout");
      expect(reply.error).toBe("run did not finish");
    });
  });

  // ── no-op methods ──────────────────────────────────────────

  describe("no-op methods", () => {
    it("subscribe() returns an unsubscribe function", () => {
      const unsub = transport.subscribe("main", async () => {});
      expect(typeof unsub).toBe("function");
      // Calling unsub should not throw
      unsub();
    });

    it("broadcast() does not throw", () => {
      expect(() => transport.broadcast("agent", { text: "hi" })).not.toThrow();
    });

    it("start() resolves", async () => {
      await expect(transport.start()).resolves.toBeUndefined();
    });

    it("stop() resolves", async () => {
      await expect(transport.stop()).resolves.toBeUndefined();
    });
  });
});

// ── Factory ────────────────────────────────────────────────────

describe("createTransport()", () => {
  it("returns WebSocketTransport by default (no config)", () => {
    const t = createTransport();
    expect(t).toBeInstanceOf(WebSocketTransport);
  });

  it("returns WebSocketTransport when backend is 'websocket'", () => {
    const t = createTransport({ transport: { backend: "websocket" } });
    expect(t).toBeInstanceOf(WebSocketTransport);
  });

  it("throws for 'redis' backend (not yet implemented)", () => {
    expect(() => createTransport({ transport: { backend: "redis" } })).toThrow(
      "Redis transport is not yet implemented",
    );
  });

  it("throws for 'kafka' backend (not yet implemented)", () => {
    expect(() => createTransport({ transport: { backend: "kafka" } })).toThrow(
      "Kafka transport is not yet implemented",
    );
  });

  it("falls back to WebSocketTransport for unknown backend", () => {
    const t = createTransport({ transport: { backend: "unknown" as "websocket" } });
    expect(t).toBeInstanceOf(WebSocketTransport);
  });
});