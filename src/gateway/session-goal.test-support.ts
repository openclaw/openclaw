import type { SessionGoal } from "../config/sessions/types.js";
export function createSessionGoalFixture(
  id: string,
  objective: string,
  overrides: Partial<SessionGoal> = {},
): SessionGoal {
  return {
    schemaVersion: 1,
    id,
    objective,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
    ...overrides,
  };
}
