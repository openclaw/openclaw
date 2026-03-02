import { describe, expect, test } from "vitest";
import {
  clearAgentRunContext,
  emitAgentEvent,
  getAgentRunContext,
  onAgentEvent,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "./agent-events.js";

describe("agent-events sequencing", () => {
  test("stores and clears run context", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-1", { sessionKey: "main" });
    expect(getAgentRunContext("run-1")?.sessionKey).toBe("main");
    clearAgentRunContext("run-1");
    expect(getAgentRunContext("run-1")).toBeUndefined();
  });

  test("maintains monotonic seq per runId", async () => {
    const seen: Record<string, number[]> = {};
    const stop = onAgentEvent((evt) => {
      const list = seen[evt.runId] ?? [];
      seen[evt.runId] = list;
      list.push(evt.seq);
    });

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-2", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });

    stop();

    expect(seen["run-1"]).toEqual([1, 2, 3]);
    expect(seen["run-2"]).toEqual([1]);
  });

  test("preserves compaction ordering on the event bus", async () => {
    const phases: Array<string> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId !== "run-1") {
        return;
      }
      if (evt.stream !== "compaction") {
        return;
      }
      if (typeof evt.data?.phase === "string") {
        phases.push(evt.data.phase);
      }
    });

    emitAgentEvent({ runId: "run-1", stream: "compaction", data: { phase: "start" } });
    emitAgentEvent({
      runId: "run-1",
      stream: "compaction",
      data: { phase: "end", willRetry: false },
    });

    stop();

    expect(phases).toEqual(["start", "end"]);
  });

  test("omits sessionKey for runs hidden from Control UI", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-hidden", {
      sessionKey: "session-imessage",
      isControlUiVisible: false,
    });

    let receivedSessionKey: string | undefined;
    const stop = onAgentEvent((evt) => {
      receivedSessionKey = evt.sessionKey;
    });
    emitAgentEvent({
      runId: "run-hidden",
      stream: "assistant",
      data: { text: "hi" },
      sessionKey: "session-imessage",
    });
    stop();

    expect(receivedSessionKey).toBeUndefined();
  });
});

describe("RFC-A2A-RESPONSE-ROUTING: registerAgentRunContext", () => {
  test("updates returnTo on existing context", () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-a2a-1", { sessionKey: "agent:metis:main" });
    registerAgentRunContext("run-a2a-1", {
      returnTo: "agent:main:main",
      correlationId: "corr-123",
    });

    const ctx = getAgentRunContext("run-a2a-1");
    expect(ctx?.sessionKey).toBe("agent:metis:main");
    expect(ctx?.returnTo).toBe("agent:main:main");
    expect(ctx?.correlationId).toBe("corr-123");
  });

  test("updates correlationId on existing context", () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-a2a-2", { sessionKey: "agent:clio:main" });
    registerAgentRunContext("run-a2a-2", { correlationId: "corr-456" });

    const ctx = getAgentRunContext("run-a2a-2");
    expect(ctx?.correlationId).toBe("corr-456");
  });

  test("updates timeout on existing context", () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-a2a-3", { sessionKey: "agent:deepthought:main" });
    registerAgentRunContext("run-a2a-3", { timeout: 60 });

    const ctx = getAgentRunContext("run-a2a-3");
    expect(ctx?.timeout).toBe(60);
  });

  test("can update all A2A fields after initial registration", () => {
    resetAgentRunContextForTest();
    // Initial registration with just sessionKey
    registerAgentRunContext("run-a2a-4", { sessionKey: "agent:metis:main" });

    // Add A2A routing info
    registerAgentRunContext("run-a2a-4", {
      returnTo: "agent:main:main",
      correlationId: "corr-789",
      timeout: 120,
    });

    const ctx = getAgentRunContext("run-a2a-4");
    expect(ctx).toEqual({
      sessionKey: "agent:metis:main",
      returnTo: "agent:main:main",
      correlationId: "corr-789",
      timeout: 120,
    });
  });

  test("does not overwrite A2A fields with undefined", () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-a2a-5", {
      sessionKey: "agent:metis:main",
      returnTo: "agent:main:main",
      correlationId: "corr-abc",
      timeout: 60,
    });

    // Update sessionKey without A2A fields
    registerAgentRunContext("run-a2a-5", { sessionKey: "agent:metis:other" });

    const ctx = getAgentRunContext("run-a2a-5");
    expect(ctx?.sessionKey).toBe("agent:metis:other");
    expect(ctx?.returnTo).toBe("agent:main:main"); // Preserved
    expect(ctx?.correlationId).toBe("corr-abc"); // Preserved
    expect(ctx?.timeout).toBe(60); // Preserved
  });
});
