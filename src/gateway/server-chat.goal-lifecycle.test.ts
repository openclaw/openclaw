import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  loadSessionEntry as loadStoredSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";
import { createSessionGoalFixture } from "./session-goal.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

vi.mock("../config/io.js", () => ({ getRuntimeConfig: vi.fn(() => ({})) }));
// mock-isolation: The fixture supplies its persisted session entry to the lifecycle worker adapter.
const loadSessionEntryAsync = vi.hoisted(() =>
  vi.fn<typeof import("./session-entry-load.test-support.js").loadSessionEntryAsync>(),
);
vi.mock("./session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async () =>
    await loadSessionEntryAsync("session-terminal-error"),
}));

const persistGatewaySessionLifecycleEventMock = vi.fn();

beforeEach(() => {
  resetAgentEventsForTest({ preserveListeners: true });
  vi.mocked(loadSessionEntryAsync).mockReset();
  persistGatewaySessionLifecycleEventMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  resetAgentEventsForTest({ preserveListeners: true });
});

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
    const sessionKey = "agent:main:session-terminal-error";
    const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
    const target = { storePath, sessionKey };
    const read = () => loadStoredSessionEntry({ ...target, readConsistency: "latest" });
    await replaceSessionEntry(target, {
      sessionId: "session-terminal",
      updatedAt: 1_000,
      startedAt: 1_000,
      goal: createSessionGoalFixture("terminal-goal", "Finish the requested work", {
        createdAt: 1_000,
        updatedAt: 1_000,
      }),
    });
    vi.mocked(loadSessionEntryAsync).mockImplementation(async () => ({
      cfg: {},
      agentId: "main",
      storePath,
      store: {},
      entry: read(),
      canonicalKey: sessionKey,
      storeKeys: [sessionKey],
      legacyKey: undefined,
    }));
    persistGatewaySessionLifecycleEventMock.mockImplementation(persistGatewaySessionLifecycleEvent);
    const h = createAgentEventTestHarness({
      resolveSessionKeyForRun: () => sessionKey,
      loadGatewaySessionLifecycleSnapshotForEvent: () => {
        const entry = read();
        if (!entry) {
          throw new Error("Expected the persisted goal session");
        }
        return { row: { kind: "direct", ...entry, key: sessionKey } };
      },
      persistGatewaySessionLifecycleEventForEvent: persistGatewaySessionLifecycleEventMock,
    });
    const settle = () =>
      Promise.all(persistGatewaySessionLifecycleEventMock.mock.results.map(({ value }) => value));
    try {
      vi.useFakeTimers();
      vi.setSystemTime(2_000);
      h.sessionEventSubscribers.subscribe("conn-session");
      registerAgentRunContext("run-terminal-final-failure", { sessionKey });

      await h.emitMany("run-terminal-final-failure", [
        ["lifecycle", { phase: "error", error: "Retryable provider failure." }],
        [
          "tool",
          { phase: "result", name: "read", isError: true, result: "An earlier tool failed." },
        ],
      ]);
      expect(read()?.goal?.status).toBe("active");
      expect(persistGatewaySessionLifecycleEventMock).not.toHaveBeenCalled();
      await h.emitMany("run-terminal-final-failure", [
        ["lifecycle", { phase: "error", startedAt: 1_000, endedAt: 2_000, ...terminal }],
      ]);
      await settle();

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
      expect(h.changes()[0]?.[1]).toMatchObject({
        status,
        lastRunError: terminal.error,
        session: { goal: stoppedGoal },
      });

      vi.setSystemTime(3_000);
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      await h.emitMany("run-recovered", [
        ["lifecycle", { phase: "start", startedAt: 3_000 }, { lifecycleGeneration }],
        ["lifecycle", { phase: "end", startedAt: 3_000, endedAt: 4_000 }, { lifecycleGeneration }],
      ]);
      await settle();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(read()).toMatchObject({
        status: "done",
        startedAt: 3_000,
        endedAt: 4_000,
        goal: stoppedGoal,
      });
      expect(read()?.lastRunError).toBeUndefined();
      expect(h.chat().map(([, payload]) => payload.state)).toEqual(["error", "final"]);
    } finally {
      await h.handler.dispose();
      vi.useRealTimers();
    }
  }),
);
