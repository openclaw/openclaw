import path from "node:path";
// Imported by agent.test.ts to keep session rotation on the shared mocked module graph.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import {
  describe0AfterEach0,
  expectRecordFields,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  mockCallArg,
  useTestStateDir,
  waitForAgentCommandCall,
} from "./agent.test-harness.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";

const mocks = getAgentTestMocks();

describe("gateway agent handler", () => {
  afterEach(describe0AfterEach0);

  it("rolls stale gateway agent sessions even when updatedAt was recently touched", async () => {
    await withTestDir({ prefix: "openclaw-agent-session-rotation-" }, async (root) => {
      useTestStateDir(root);
      const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
      mocks.userTurnStorePath = storePath;
      const now = Date.parse("2026-04-25T12:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const executionWork = new AsyncWorkScope();
      const broadcastToConnIds = vi.fn();
      const context = {
        ...makeContext(),
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      };
      try {
        mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:main:main");
        const loaded = {
          cfg: { session: { reset: { mode: "daily", atHour: 4 } } },
          storePath,
          canonicalKey: "agent:main:main",
          entry: {
            sessionId: "stale-session-id",
            updatedAt: now,
            sessionStartedAt: now - 25 * 60 * 60_000,
            lastInteractionAt: now - 25 * 60 * 60_000,
          },
        };
        const store: Record<string, Record<string, unknown>> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        mocks.loadSessionEntry.mockImplementation(() => ({
          ...loaded,
          entry: store[loaded.canonicalKey],
        }));
        let capturedEntry: Record<string, unknown> | undefined;
        mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
          const result = await updater(store);
          capturedEntry = result as Record<string, unknown>;
          return result;
        });
        mocks.agentCommand.mockResolvedValue({
          payloads: [{ text: "ok" }],
          meta: { durationMs: 100 },
        });

        const respond = await executionWork.track(() =>
          invokeAgent(
            {
              message: "daily rollover",
              agentId: "main",
              sessionKey: "agent:main:main",
              idempotencyKey: "daily-rollover-agent-session",
            },
            {
              reqId: "daily-rollover-agent-session",
              context,
            },
          ),
        );

        expect(respond.mock.calls).toContainEqual([
          true,
          expect.objectContaining({ status: "accepted" }),
          undefined,
          { runId: "daily-rollover-agent-session" },
        ]);

        const call = await waitForAgentCommandCall<{
          sessionId?: string;
          sessionKey?: string;
        }>();
        expect(call.sessionKey).toBe("agent:main:main");
        expect(call.sessionId).not.toBe("stale-session-id");
        expect(capturedEntry?.sessionStartedAt).toBe(now);
        expect(capturedEntry?.lastInteractionAt).toBe(now);
        expect(mocks.emitGatewaySessionEndPluginHook).toHaveBeenCalledTimes(1);
        expectRecordFields(
          mockCallArg(mocks.emitGatewaySessionEndPluginHook) as Record<string, unknown>,
          {
            sessionKey: "agent:main:main",
            sessionId: "stale-session-id",
            reason: "daily",
            storePath,
            nextSessionId: call.sessionId,
            nextSessionKey: "agent:main:main",
          },
        );
        expect(mocks.emitGatewaySessionStartPluginHook).toHaveBeenCalledTimes(1);
        expectRecordFields(
          mockCallArg(mocks.emitGatewaySessionStartPluginHook) as Record<string, unknown>,
          {
            sessionKey: "agent:main:main",
            sessionId: call.sessionId,
            resumedFrom: "stale-session-id",
            storePath,
          },
        );
        await vi.advanceTimersByTimeAsync(100);
        expect(broadcastToConnIds.mock.calls.map((callValue) => callValue[1]?.reason)).toEqual([
          "create",
          "agent.input.settled",
        ]);
      } finally {
        try {
          await executionWork.runWhenIdle(() => flushPendingSessionsChangedEvents(context));
        } finally {
          await executionWork.drain();
          vi.useRealTimers();
        }
      }
    });
  });

  it("emits lifecycle hooks and sessions.changed when an explicit sessionId replaces a fresh session", async () => {
    await withTestDir({ prefix: "openclaw-agent-session-rotation-" }, async (root) => {
      useTestStateDir(root);
      const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
      mocks.userTurnStorePath = storePath;
      const now = Date.parse("2026-04-25T12:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const executionWork = new AsyncWorkScope();
      const broadcastToConnIds = vi.fn();
      const context = {
        ...makeContext(),
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      };
      try {
        const loaded = {
          cfg: {},
          storePath,
          canonicalKey: "agent:main:main",
          entry: {
            sessionId: "current-session-id",
            updatedAt: now,
            sessionStartedAt: now,
            lastInteractionAt: now,
          },
        };
        const store: Record<string, Record<string, unknown>> = {
          [loaded.canonicalKey]: structuredClone(loaded.entry),
        };
        mocks.loadSessionEntry.mockImplementation(() => ({
          ...loaded,
          entry: store[loaded.canonicalKey],
        }));
        let capturedEntry: Record<string, unknown> | undefined;
        mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
          const result = await updater(store);
          capturedEntry = result as Record<string, unknown>;
          return result;
        });
        mocks.agentCommand.mockResolvedValue({
          payloads: [{ text: "ok" }],
          meta: { durationMs: 100 },
        });

        const respond = await executionWork.track(() =>
          invokeAgent(
            {
              message: "explicit replacement",
              agentId: "main",
              sessionKey: "agent:main:main",
              sessionId: "caller-selected-session-id",
              idempotencyKey: "explicit-replacement-agent-session",
            },
            {
              reqId: "explicit-replacement-agent-session",
              context,
            },
          ),
        );

        expect(respond.mock.calls).toContainEqual([
          true,
          expect.objectContaining({ status: "accepted" }),
          undefined,
          { runId: "explicit-replacement-agent-session" },
        ]);

        const call = await waitForAgentCommandCall<{
          sessionId?: string;
          sessionKey?: string;
        }>();
        expect(call.sessionKey).toBe("agent:main:main");
        expect(call.sessionId).toBe("caller-selected-session-id");
        expect(capturedEntry?.sessionId).toBe("caller-selected-session-id");
        expect(capturedEntry?.sessionStartedAt).toBe(now);
        expect(mocks.emitGatewaySessionEndPluginHook).toHaveBeenCalledTimes(1);
        expectRecordFields(
          mockCallArg(mocks.emitGatewaySessionEndPluginHook) as Record<string, unknown>,
          {
            sessionKey: "agent:main:main",
            sessionId: "current-session-id",
            reason: "new",
            storePath,
            nextSessionId: "caller-selected-session-id",
            nextSessionKey: "agent:main:main",
          },
        );
        expect(mocks.emitGatewaySessionStartPluginHook).toHaveBeenCalledTimes(1);
        expectRecordFields(
          mockCallArg(mocks.emitGatewaySessionStartPluginHook) as Record<string, unknown>,
          {
            sessionKey: "agent:main:main",
            sessionId: "caller-selected-session-id",
            resumedFrom: "current-session-id",
            storePath,
          },
        );
        await vi.advanceTimersByTimeAsync(100);
        expect(broadcastToConnIds.mock.calls.map((callLocal) => callLocal[1]?.reason)).toEqual([
          "create",
          "agent.input.settled",
        ]);
      } finally {
        try {
          await executionWork.runWhenIdle(() => flushPendingSessionsChangedEvents(context));
        } finally {
          await executionWork.drain();
          vi.useRealTimers();
        }
      }
    });
  });
});
