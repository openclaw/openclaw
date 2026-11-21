import { afterEach, assert, expect, it, vi } from "vitest";
import { buildCreatedSessionGoal as createGoal } from "./goals-transitions.js";
import { createSessionActorMemoryGoals } from "./session-actor-memory-goals.js";
import { createMemoryTestState } from "./session-actor-memory-publication.test-support.js";

const sessionKey = "agent:main:dashboard:incognito-side-state";
const sessionId = "session-1";
const now = 1_000_000;
const edit = {
  sessionKey,
  expectedSessionId: sessionId,
  operation: {
    action: "edit" as const,
    goalId: "goal-1",
    operationId: "edit-1",
    requestFingerprint: "request-1",
    issuedAtMs: now,
    objective: "First edit",
  },
};

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const entry = { sessionId, updatedAt: now };
  const state = createMemoryTestState(sessionKey, {
    ...entry,
    incognito: true,
    forkSource: { sessionKey: "agent:main:parent", sessionId: "parent-session" },
    goal: {
      ...createGoal(entry, { objective: "Original objective" }, now),
      id: "goal-1",
      tokenStartFresh: true,
    },
  });
  const goals = createSessionActorMemoryGoals({
    state,
    agentId: "main",
    path: "/memory",
  });
  const mutate = (operation = edit.operation) => goals.mutate({ ...edit, operation });
  return { state, goals, mutate };
}

it("replays Goal receipts without overwriting a later edit or exposing its stored objects", () => {
  const { state, mutate } = fixture();
  const first = mutate();
  expect(first).toMatchObject({
    replayed: false,
    result: { status: "updated", goal: { objective: "First edit" } },
  });
  const { result, sessionEntry, previous } = first;
  assert(result.goal && sessionEntry?.goal && previous?.goal && previous.forkSource);
  result.goal.objective = "Caller mutation";
  sessionEntry.goal.objective = "Changed returned entry";
  previous.goal.objective = "Changed returned previous entry";
  previous.forkSource.sessionId = "Changed shared source";
  expect(state.hot.entry?.goal?.objective).toBe("First edit");
  expect(state.hot.entry?.forkSource?.sessionId).toBe("parent-session");
  mutate({ ...edit.operation, operationId: "edit-2", objective: "Second edit" });
  expect(mutate()).toMatchObject({
    replayed: true,
    result: { goal: { objective: "First edit" } },
  });
  expect(state.hot.entry?.goal?.objective).toBe("Second edit");
  expect(() => mutate({ ...edit.operation, objective: "Conflicting retry" })).toThrow(
    "Goal operation ID was already used for a different request",
  );
  expect(state.hot.entry?.goal?.objective).toBe("Second edit");
});

it("rejects a different target key even when its session ID matches", () => {
  const { state, goals } = fixture();
  expect(() =>
    goals.mutate({
      ...edit,
      sessionKey: "agent:main:dashboard:incognito-another-session",
    }),
  ).toThrow("Goal operation does not target this session actor");
  expect(state.hot.entry?.goal?.objective).toBe("Original objective");
});

it("does not recreate a cleared Goal when an old operation expires", () => {
  const { state, goals } = fixture();
  const operation = {
    action: "clear" as const,
    goalId: "goal-1",
    operationId: "clear-1",
    requestFingerprint: "request-clear",
    issuedAtMs: now,
  };
  goals.mutate({ sessionKey, expectedSessionId: sessionId, operation });
  expect(state.hot.entry?.goal).toBeUndefined();
  vi.setSystemTime(now + 24 * 60 * 60 * 1000);
  expect(() => goals.readReceipt(sessionId, operation)).toThrow("Goal operation expired");
  expect(state.hot.entry?.goal).toBeUndefined();
});
