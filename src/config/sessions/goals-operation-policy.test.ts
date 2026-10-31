import { expect, it } from "vitest";
import { applySessionGoalOperation, operationFingerprint } from "./goals-operation-policy.js";
import type { SessionGoalOperation } from "./goals-operations.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

const entry: SessionEntry = {
  sessionId: "session",
  updatedAt: 1,
  lifecycleRunId: "original-turn",
  totalTokens: 100,
  totalTokensFresh: true,
  goal: {
    schemaVersion: 1,
    id: "goal",
    objective: "Replacement",
    status: "paused",
    createdAt: 1,
    updatedAt: 2,
    pausedAt: 2,
    tokenStart: 100,
    tokensUsed: 12,
    tokenBudget: 50,
    continuationTurns: 3,
  },
};
const resume: SessionGoalOperation & { action: "resume" } = {
  operationId: "request",
  issuedAtMs: 1,
  requestFingerprint: "immutable-decision",
  action: "resume",
  goalId: "goal",
  preserveBudget: true,
  replacementSource: { runId: "original-turn", goal: entry.goal! },
};
it("retains the replacement budget window and rejects exhausted budgets rather than resetting them", () => {
  expect(applySessionGoalOperation(entry, resume, 10)).toMatchObject({
    id: "goal",
    status: "active",
    tokenStart: 100,
    tokensUsed: 12,
    tokenBudget: 50,
    continuationTurns: 3,
  });
  const exhausted = { ...entry, goal: { ...entry.goal!, tokensUsed: 50 } };
  expect(() =>
    applySessionGoalOperation(
      exhausted,
      { ...resume, replacementSource: { ...resume.replacementSource!, goal: exhausted.goal } },
      10,
    ),
  ).toThrow("budget was reached");
  expect(exhausted.goal.tokensUsed).toBe(50);
});
it.each(["run", "goal", "completed"])(
  "rejects a changed %s in the continuation transaction",
  (change) => {
    const current = { ...entry, goal: { ...entry.goal! } };
    if (change === "run") {
      current.lifecycleRunId = "newer-turn";
    }
    if (change === "goal") {
      current.goal.objective = "Newer decision";
    }
    if (change === "completed") {
      current.goal.status = "complete";
    }
    expect(() => applySessionGoalOperation(current, resume, 10)).toThrow("goal or turn changed");
  },
);
it("uses the immutable decision for receipts, not its derived postimage", () => {
  const { replacementSource: _source, ...lookup } = resume;
  expect(operationFingerprint(resume)).toBe(operationFingerprint(lookup));
  expect(operationFingerprint(resume)).not.toBe(
    operationFingerprint({ ...lookup, preserveBudget: undefined }),
  );
});
