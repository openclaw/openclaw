// Imported by agent.test.ts to share its existing Gateway fixture and module graph.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backendGatewayClient,
  describe0AfterEach0,
  expectRespondError,
  getAgentTestMocks,
  invokeAgent,
  mockMainSessionEntry,
  primeMainAgentRun,
  waitForAgentCommandCall,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway expected-session admission", () => {
  afterEach(describe0AfterEach0);

  it.each([
    {
      name: "original unversioned generation",
      expected: null,
      loaded: undefined,
      fresh: undefined,
      allowed: true,
    },
    {
      name: "current revised generation",
      expected: "current",
      loaded: "current",
      fresh: "current",
      allowed: true,
    },
    {
      name: "reset of unversioned generation",
      expected: null,
      loaded: "reset",
      fresh: "reset",
      allowed: false,
    },
    {
      name: "reset of revised generation",
      expected: "original",
      loaded: "reset",
      fresh: "reset",
      allowed: false,
    },
    {
      name: "reset after initial read",
      expected: "original",
      loaded: "original",
      fresh: "reset",
      allowed: false,
    },
  ])(
    "fences backend requester continuation against $name",
    async ({ expected, loaded: revision, fresh, allowed }) => {
      mockMainSessionEntry({
        sessionId: "requester-session",
        updatedAt: Date.now(),
        lifecycleRevision: revision,
      });
      const loaded = mocks.loadSessionEntry();
      mocks.updateSessionStore.mockImplementation(
        async (_path, updater) =>
          await updater({
            [loaded.canonicalKey]: { ...loaded.entry, lifecycleRevision: fresh },
          }),
      );
      mocks.agentCommand.mockClear();
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: { durationMs: 1 },
      });
      const respond = await invokeAgent(
        {
          message: "delayed result",
          agentId: "main",
          sessionKey: "agent:main:main",
          expectedExistingSessionId: "requester-session",
          expectedExistingSessionLifecycleRevision: expected,
          idempotencyKey: "requester-generation-continuation",
        },
        { client: backendGatewayClient() },
      );
      if (allowed) {
        expect(mocks.agentCommand).toHaveBeenCalledOnce();
      } else {
        expect(mocks.agentCommand).not.toHaveBeenCalled();
        expectRespondError(respond, { message: expect.stringContaining("changed") });
      }
    },
  );

  it("rejects an expected revision without its session identity", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = await invokeAgent(
      {
        message: "delayed result",
        agentId: "main",
        sessionKey: "agent:main:main",
        expectedExistingSessionLifecycleRevision: null,
        idempotencyKey: "requester-generation-without-session",
      },
      { client: backendGatewayClient() },
    );
    expectRespondError(respond, {
      message: "expectedExistingSessionLifecycleRevision requires expectedExistingSessionId.",
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("pins a backend continuation to its expected stale session", async () => {
    const now = Date.parse("2026-04-25T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
      mockMainSessionEntry(
        {
          sessionId: "expected-stale-session-id",
          updatedAt: now,
          sessionStartedAt: now - 25 * 60 * 60_000,
          lastInteractionAt: now - 25 * 60 * 60_000,
        },
        {
          session: {
            reset: {
              mode: "daily",
              atHour: 4,
            },
          },
        },
      );
      const loaded = mocks.loadSessionEntry();
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent(
        {
          message: "resume exact stale session",
          agentId: "main",
          sessionKey: "agent:main:main",
          expectedExistingSessionId: "expected-stale-session-id",
          idempotencyKey: "expected-stale-agent-session",
        },
        {
          reqId: "expected-stale-agent-session",
          client: backendGatewayClient(),
        },
      );

      const call = await waitForAgentCommandCall<{
        sessionId?: string;
        sessionKey?: string;
      }>();
      expect(call.sessionKey).toBe("agent:main:main");
      expect(call.sessionId).toBe("expected-stale-session-id");
      expect(capturedEntry?.sessionId).toBe("expected-stale-session-id");
      expect(mocks.emitGatewaySessionEndPluginHook).not.toHaveBeenCalled();
      expect(mocks.emitGatewaySessionStartPluginHook).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
