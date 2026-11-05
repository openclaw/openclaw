import { expect, it } from "vitest";
import { applySessionGoalOperation, operationFingerprint } from "./goals-operation-policy.js";
import type { SessionGoalOperation } from "./goals-operations.types.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "./types.js";

const entry: SessionEntry = {
  sessionId: "session",
  updatedAt: 1,
  totalTokens: 500,
  totalTokensFresh: true,
  totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
  goal: {
    schemaVersion: 1,
    id: "old-goal",
    objective: "Finished objective",
    status: "complete",
    createdAt: 1,
    updatedAt: 5,
    completedAt: 5,
    tokenStart: 10,
    tokenStartFresh: true,
    tokensUsed: 490,
    tokenBudget: 490,
    continuationTurns: 8,
  },
};
const restart: SessionGoalOperation & { action: "restart" } = {
  operationId: "confirmed-restart",
  issuedAtMs: 6,
  requestFingerprint: "request",
  action: "restart",
  goalId: "old-goal",
  expectedGoalUpdatedAt: 5,
  objective: "/new literal objective",
};

it("creates a fresh active goal from an exact completed-goal confirmation", () => {
  const result = applySessionGoalOperation(entry, restart, 10);
  expect(result).toMatchObject({
    objective: restart.objective,
    status: "active",
    createdAt: 10,
    updatedAt: 10,
    tokenStart: 500,
    tokenStartFresh: true,
    tokensUsed: 0,
    continuationTurns: 0,
  });
  expect(result?.id).not.toBe(entry.goal?.id);
  expect(result).not.toHaveProperty("completedAt");
  expect(result).not.toHaveProperty("tokenBudget");
  expect(entry.goal?.status).toBe("complete");
});

it("requires a matching goal identity and revision without allowing completed-goal edit", () => {
  for (const status of ["active", "paused"] as const) {
    expect(() =>
      applySessionGoalOperation({ ...entry, goal: { ...entry.goal!, status } }, restart, 10),
    ).toThrow("Only a completed goal");
  }
  expect(() => applySessionGoalOperation(entry, { ...restart, goalId: "rebound" }, 10)).toThrow(
    "changed",
  );
  expect(() =>
    applySessionGoalOperation(entry, { ...restart, expectedGoalUpdatedAt: 4 }, 10),
  ).toThrow("changed");
  expect(() => applySessionGoalOperation(entry, { ...restart, action: "edit" }, 10)).toThrow();
  expect(operationFingerprint(restart)).not.toBe(
    operationFingerprint({ ...restart, expectedGoalUpdatedAt: 4 }),
  );
});
