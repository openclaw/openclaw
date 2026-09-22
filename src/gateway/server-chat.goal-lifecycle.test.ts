import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry as loadStoredSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { emitAgentEvents } from "./server-chat.agent-events.test-helpers.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { loadSessionEntry } from "./session-utils.js";

vi.mock("../config/io.js", () => ({ getRuntimeConfig: vi.fn(() => ({})) }));
vi.mock("./session-utils.js", () => {
  const load = vi.fn();
  return { loadSessionEntry: load, loadGatewaySessionEntryReadOnly: load };
});

const persistGatewaySessionLifecycleEventMock = vi.fn();
const loadGatewaySessionRow = vi.fn();

beforeEach(() => {
  resetAgentEventsForTest({ preserveListeners: true });
  vi.mocked(loadSessionEntry).mockReset();
  persistGatewaySessionLifecycleEventMock.mockReset();
  loadGatewaySessionRow.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  resetAgentEventsForTest({ preserveListeners: true });
});

function createHarness(params: { resolveSessionKeyForRun: () => string }) {
  const broadcast = vi.fn();
  const broadcastToConnIds = vi.fn();
  const chatRunState = createChatRunState();
  const sessionEventSubscribers = createSessionEventSubscriberRegistry();
  const handler = createAgentEventHandler({
    broadcast,
    broadcastToConnIds,
    nodeSendToSession: vi.fn(),
    nodeHasSessionSubscribers: () => true,
    agentRunSeq: new Map(),
    chatRunState,
    resolveSessionKeyForRun: params.resolveSessionKeyForRun,
    clearAgentRunContext: vi.fn(),
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionEventSubscribers,
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    loadGatewaySessionLifecycleSnapshotForEvent: () => ({ row: loadGatewaySessionRow() }),
    persistGatewaySessionLifecycleEventForEvent: persistGatewaySessionLifecycleEventMock,
  });
  return { broadcast, broadcastToConnIds, sessionEventSubscribers, handler };
}

describe("agent event goal lifecycle", () => {
  it.each([
    {
      name: "fallback-exhausted failure",
      terminal: {
        error: "LLM request failed: network connection error.",
        fallbackExhaustedFailure: true,
      },
      status: "failed",
    },
    {
      name: "provider timeout after a tool error",
      terminal: {
        error:
          "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
        aborted: false,
        timeoutPhase: "provider",
        providerStarted: true,
      },
      status: "timeout",
    },
  ])("persists $name without waiting for retry grace", ({ terminal, status }) =>
    withOpenClawTestState({ label: "terminal-projection" }, async (state) => {
      const sessionKey = "session-terminal-error";
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      const target = { storePath, sessionKey };
      const read = () => loadStoredSessionEntry({ ...target, readConsistency: "latest" });
      await replaceSessionEntry(target, {
        sessionId: "session-terminal",
        updatedAt: 1_000,
        status: "running",
        startedAt: 1_000,
        goal: {
          schemaVersion: 1,
          id: "terminal-goal",
          objective: "Finish the requested work",
          status: "active",
          createdAt: 1_000,
          updatedAt: 1_000,
          tokenStart: 0,
          tokensUsed: 0,
          continuationTurns: 0,
        },
      });
      vi.mocked(loadSessionEntry).mockImplementation(() => ({
        cfg: {},
        agentId: "main",
        storePath,
        store: {},
        entry: read(),
        canonicalKey: sessionKey,
        storeKeys: [sessionKey],
        legacyKey: undefined,
      }));
      loadGatewaySessionRow.mockImplementation(() => ({
        kind: "direct",
        ...read(),
        key: sessionKey,
      }));
      persistGatewaySessionLifecycleEventMock.mockImplementation(
        persistGatewaySessionLifecycleEvent,
      );
      const { broadcast, broadcastToConnIds, sessionEventSubscribers, handler } = createHarness({
        resolveSessionKeyForRun: () => sessionKey,
      });
      try {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        sessionEventSubscribers.subscribe("conn-session");
        registerAgentRunContext("run-terminal-final-failure", { sessionKey });

        emitAgentEvents(handler, "run-terminal-final-failure", [
          ["lifecycle", { phase: "error", error: "Retryable provider failure." }],
          [
            "tool",
            { phase: "result", name: "read", isError: true, result: "An earlier tool failed." },
          ],
        ]);
        expect(read()?.goal?.status).toBe("active");
        expect(persistGatewaySessionLifecycleEventMock).not.toHaveBeenCalled();
        emitAgentEvents(handler, "run-terminal-final-failure", [
          ["lifecycle", { phase: "error", startedAt: 1_000, endedAt: 2_000, ...terminal }],
        ]);
        await Promise.all(
          persistGatewaySessionLifecycleEventMock.mock.results.map((result) => result.value),
        );

        const stoppedGoal = {
          id: "terminal-goal",
          status: "paused",
          pausedAt: 2_000,
          lastStatusNote: expect.stringContaining(terminal.error),
        };
        expect(read()).toMatchObject({
          status,
          lastRunError: terminal.error,
          endedAt: 2_000,
          goal: stoppedGoal,
        });
        expect(
          broadcastToConnIds.mock.calls.find(([event]) => event === "sessions.changed")?.[1],
        ).toMatchObject({ status, lastRunError: terminal.error, session: { goal: stoppedGoal } });

        vi.setSystemTime(3_000);
        emitAgentEvents(handler, "run-recovered", [
          ["lifecycle", { phase: "start", startedAt: 3_000 }],
          ["lifecycle", { phase: "end", startedAt: 3_000, endedAt: 4_000 }],
        ]);
        await Promise.all(
          persistGatewaySessionLifecycleEventMock.mock.results.map((result) => result.value),
        );
        await vi.advanceTimersByTimeAsync(15_000);
        expect(read()).toMatchObject({ status: "done", startedAt: 3_000, endedAt: 4_000 });
        expect(read()?.lastRunError).toBeUndefined();
        expect(read()?.goal).toMatchObject(stoppedGoal);
        expect(
          broadcast.mock.calls
            .filter(([event]) => event === "chat")
            .map(([, payload]) => payload.state),
        ).toEqual(["error", "final"]);
      } finally {
        handler.dispose();
        vi.useRealTimers();
      }
    }),
  );
});
