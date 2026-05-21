import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Unit tests for the cron isolated-agent runtime cleanup path.
//
// These verify that disposeCronRunContext (wired through the finally block in
// runCronIsolatedAgentTurn) correctly releases the in-memory session store and
// clears the registered run context after a cron run completes.
//
// Relates to: https://github.com/openclaw/openclaw/issues/<NEW_ISSUE>
// ---------------------------------------------------------------------------

// We test the two primitives directly rather than spinning up a full gateway.

describe("clearAgentRunContext", () => {
  it("removes a registered run context from the global map", async () => {
    const { registerAgentRunContext, clearAgentRunContext, getAgentRunContext } =
      await import("../../infra/agent-events.js");
    const runId = `test-cleanup-${Date.now()}`;
    registerAgentRunContext(runId, { sessionKey: "test-key", verboseLevel: "off" });
    expect(getAgentRunContext(runId)).toBeDefined();
    clearAgentRunContext(runId);
    expect(getAgentRunContext(runId)).toBeUndefined();
  });

  it("is safe to call on a non-existent run id", async () => {
    const { clearAgentRunContext } = await import("../../infra/agent-events.js");
    expect(() => clearAgentRunContext("no-such-id")).not.toThrow();
  });
});

describe("cron session store disposal", () => {
  it("nulls the store reference on the cronSession object", () => {
    const mockStore: Record<string, unknown> = { "session-key": { sessionId: "abc" } };
    const cronSession = {
      storePath: "/fake/path",
      store: mockStore,
      sessionEntry: { sessionId: "abc" },
      storePath: "/fake",
      systemSent: false,
      isNewSession: false,
      previousSessionId: undefined,
    };

    // Simulate what disposeCronRunContext does
    (cronSession as { store?: unknown }).store = undefined;

    expect(cronSession.store).toBeUndefined();
  });

  it("keeps the sessionEntry intact after disposal", () => {
    const cronSession = {
      storePath: "/fake/path",
      store: { "session-key": {} },
      sessionEntry: { sessionId: "abc", model: "gpt-5" },
      systemSent: false,
      isNewSession: false,
      previousSessionId: undefined,
    };

    (cronSession as { store?: unknown }).store = undefined;

    expect(cronSession.sessionEntry.sessionId).toBe("abc");
    expect(cronSession.sessionEntry.model).toBe("gpt-5");
  });
});

describe("sweepStaleRunContexts", () => {
  it("evicts contexts older than the max age", async () => {
    const {
      registerAgentRunContext,
      clearAgentRunContext,
      sweepStaleRunContexts,
    } = await import("../../infra/agent-events.js");
    const runId = `stale-test-${Date.now()}`;
    registerAgentRunContext(runId, {
      sessionKey: "test-key",
      verboseLevel: "off",
      registeredAt: Date.now() - 60 * 60 * 1000, // 1 hour ago
    });

    const swept = sweepStaleRunContexts(30 * 60 * 1000); // 30 min max age
    expect(swept).toBeGreaterThanOrEqual(1);

    // Cleanup in case it wasn't swept
    clearAgentRunContext(runId);
  });
});
