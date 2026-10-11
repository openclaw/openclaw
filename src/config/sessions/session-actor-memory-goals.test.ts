import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionActorMemoryGoals } from "./session-actor-memory-goals.js";
import type { SessionActorMemoryState } from "./session-actor-memory-state.js";

const sessionKey = "agent:main:dashboard:incognito-side-state";
const sessionId = "session-1";
const now = 1_000_000;

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const state: SessionActorMemoryState = {
    hot: {
      target: {
        database: { kind: "memory", handle: "memory-1", incarnation: "incarnation-1" },
        sessionKey,
      },
      version: { epoch: "epoch-1", sequence: 0 },
      writeToken: "0",
      dependencySessionIds: [sessionId],
      entry: {
        sessionId,
        updatedAt: now,
        incognito: true,
        origin: { provider: "synthetic" },
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "Original objective",
          status: "active",
          createdAt: now,
          updatedAt: now,
          tokenStart: 0,
          tokenStartFresh: true,
          tokensUsed: 0,
          continuationTurns: 0,
        },
      },
      participants: [],
      members: [],
      pendingInputs: [],
      completionKeys: [],
      transcript: {
        watermark: { generation: null, maxSeq: null },
        version: { generation: null, rawSeq: null, updatedAt: null },
        anchorsState: "resident",
        anchors: [],
        idempotency: [],
        modelContext: { kind: "resident", entries: [] },
      },
    },
    events: [],
    pendingInputs: new Map(),
    completions: new Map(),
    goalReceipts: new Map(),
  };
  return {
    state,
    goals: createSessionActorMemoryGoals({ state, agentId: "main", path: "/synthetic/incognito" }),
  };
}

describe("memory actor Goal receipts", () => {
  it("replays Goal receipts without overwriting a later edit or exposing its stored objects", () => {
    const { state, goals } = fixture();
    const input = {
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
    const first = goals.mutate(input);
    expect(first).toMatchObject({
      replayed: false,
      result: { status: "updated", goal: { objective: "First edit" } },
    });
    if (!first.result.goal) {
      throw new Error("Expected edited Goal");
    }
    first.result.goal.objective = "Caller mutation";
    if (!first.sessionEntry?.goal || !first.previous?.goal || !first.previous.origin) {
      throw new Error("Expected committed and previous Goal entries");
    }
    first.sessionEntry.goal.objective = "Changed returned entry";
    first.previous.goal.objective = "Changed returned previous entry";
    first.previous.origin.provider = "Changed shared origin";
    expect(state.hot.entry?.goal?.objective).toBe("First edit");
    expect(state.hot.entry?.origin?.provider).toBe("synthetic");
    goals.mutate({
      ...input,
      operation: { ...input.operation, operationId: "edit-2", objective: "Second edit" },
    });
    expect(goals.mutate(input)).toMatchObject({
      replayed: true,
      result: { goal: { objective: "First edit" } },
    });
    expect(state.hot.entry?.goal?.objective).toBe("Second edit");
    expect(() =>
      goals.mutate({ ...input, operation: { ...input.operation, objective: "Conflicting retry" } }),
    ).toThrow("Goal operation ID was already used for a different request");
    expect(state.hot.entry?.goal?.objective).toBe("Second edit");
  });

  it("rejects a different target key even when its session ID matches", () => {
    const { state, goals } = fixture();
    expect(() =>
      goals.mutate({
        sessionKey: "agent:main:dashboard:incognito-another-session",
        expectedSessionId: sessionId,
        operation: {
          action: "edit",
          goalId: "goal-1",
          operationId: "wrong-target",
          requestFingerprint: "request-wrong-target",
          issuedAtMs: now,
          objective: "Misrouted edit",
        },
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
});
