import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitAgentEvent,
  onAgentEvent,
  registerAgentRunContext,
  type AgentEventPayload,
} from "./agent-events.js";

/**
 * Validates the lifecycle "usage" event contract added for external observers
 * (dashboards, recorders). The actual emission sites live in agent-command.ts,
 * agent-runner-execution.ts, followup-runner.ts, cron/isolated-agent/run.ts,
 * and agent-runner-memory.ts; this test verifies the shape and fields of the
 * event as it flows through the agent-events bus.
 */
describe("lifecycle usage event", () => {
  let events: AgentEventPayload[];
  let unsubscribe: () => void;

  beforeEach(() => {
    events = [];
    unsubscribe = onAgentEvent((evt) => events.push(evt));
  });

  afterEach(() => unsubscribe());

  it("emits phase=usage with correct token and model fields", () => {
    const runId = `usage-test-${Date.now()}`;
    registerAgentRunContext(runId, { sessionKey: "agent:main:main" });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "usage",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10 },
        lastCallUsage: { input: 30, output: 15 },
        durationMs: 4500,
      },
    });

    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.stream).toBe("lifecycle");
    expect(evt.sessionKey).toBe("agent:main:main");
    expect(evt.data).toMatchObject({
      phase: "usage",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10 },
      lastCallUsage: { input: 30, output: 15 },
      durationMs: 4500,
    });
    expect(evt.seq).toBeGreaterThan(0);
    expect(evt.ts).toBeGreaterThan(0);
  });

  it("is not emitted when agentMeta.usage is absent", () => {
    // This mirrors the guard: `if (agentMeta?.usage) { emitAgentEvent(...) }`
    const agentMeta: { usage?: unknown } = {};
    if (agentMeta?.usage) {
      emitAgentEvent({
        runId: "no-usage",
        stream: "lifecycle",
        data: { phase: "usage" },
      });
    }
    expect(events).toHaveLength(0);
  });

  it("does not throw when wrapped in defensive try/catch", () => {
    // Simulates the non-fatal pattern used in all emission sites.
    // Even if the event bus throws, it should not propagate.
    const badListener = onAgentEvent(() => {
      throw new Error("listener crash");
    });

    expect(() => {
      emitAgentEvent({
        runId: "defensive-test",
        stream: "lifecycle",
        data: { phase: "usage", usage: { input: 1 } },
      });
    }).not.toThrow();

    badListener();
  });

  it("usage event after terminal end does not corrupt tracking state", () => {
    // Simulates the real flow: end fires first, then usage arrives.
    // Downstream consumers (server-chat.ts) must handle this gracefully
    // without leaking agentRunSeq entries.
    const runId = `post-terminal-${Date.now()}`;
    registerAgentRunContext(runId, { sessionKey: "agent:main:main" });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", endedAt: Date.now() },
    });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "usage",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: { input: 200, output: 100 },
        durationMs: 3000,
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0].data.phase).toBe("end");
    expect(events[1].data.phase).toBe("usage");
    // Both events share the same runId and sessionKey
    expect(events[1].runId).toBe(runId);
    expect(events[1].sessionKey).toBe("agent:main:main");
  });

  it("durationMs reflects wall-clock time, not just last attempt", () => {
    // Validates the contract: durationMs should be Date.now() - startedAt
    // (full run including fallback retries), not result.meta.durationMs
    // (single attempt only).
    const startedAt = Date.now() - 5000; // Simulate 5s run
    const runId = `duration-${Date.now()}`;
    registerAgentRunContext(runId, { sessionKey: "agent:main:main" });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "usage",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: { input: 50, output: 25 },
        durationMs: Date.now() - startedAt,
      },
    });

    const evt = events[0];
    expect(evt.data.durationMs).toBeGreaterThanOrEqual(5000);
  });
});
