import path from "node:path";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore as upsertAccessorSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sqliteSchedulerClock } from "../../infra/sqlite-maintenance-fixture.test-support.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createCreateGoalTool, createGetGoalTool, createUpdateGoalTool } from "./goal-tools.js";

let clock: ReturnType<typeof sqliteSchedulerClock>;
beforeAll(() => {
  clock = sqliteSchedulerClock();
});
const tempDirs = useSessionStoreTempDirs(
  (cleanup) =>
    afterAll(async () => {
      try {
        await cleanup();
        const observe = observeHostDataSql();
        try {
          // A removed fixture must not checkpoint during the next test's SQL-idle window.
          await clock.advanceBy(10_000);
          expect(observe.queries).toEqual([]);
        } finally {
          observe.restore();
        }
      } finally {
        clock.restore();
      }
    }),
  "openclaw-goal-tools-",
);

async function createStoreConfig(runSessionKey = "global", entry: Partial<SessionEntry> = {}) {
  const dir = tempDirs.make();
  const template = path.join(dir, "{agentId}", "sessions.json");
  const config: OpenClawConfig = { session: { store: template } };
  const storePath = resolveSessionStorePathCore(template, {
    agentId: runSessionKey === "global" ? "research" : "ops",
  });
  await upsertAccessorSessionEntry(
    { storePath, sessionKey: runSessionKey },
    { sessionId: "sess-global", updatedAt: 1, ...entry },
  );
  return {
    options: { agentSessionKey: "global", runSessionKey, sessionAgentId: "research", config },
    readGoal: (agentId?: string) =>
      loadSessionEntry({
        storePath: agentId ? resolveSessionStorePathCore(template, { agentId }) : storePath,
        sessionKey: runSessionKey,
      })?.goal,
  };
}

function makeGoal(overrides: Partial<NonNullable<SessionEntry["goal"]>>) {
  return {
    schemaVersion: 1 as const,
    id: "goal-1",
    objective: "ship",
    status: "active" as const,
    createdAt: 1,
    updatedAt: 1,
    tokenStart: 0,
    tokenStartFresh: true,
    tokensUsed: 0,
    continuationTurns: 0,
    ...overrides,
  };
}

describe("goal tools", () => {
  it("keeps get_goal read-only when accounting changes are projected", async () => {
    const { options, readGoal } = await createStoreConfig("global", {
      totalTokens: 125,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      goal: makeGoal({ tokenStart: 100, tokenBudget: 20 }),
    });
    const result = await createGetGoalTool(options).execute("call-1", {});
    expect(result.details).toMatchObject({ goal: { status: "budget_limited" } });
    expect(readGoal()?.status).toBe("active");
  });

  it.each([
    { sessionKey: "global", budget: 100, otherAgent: "main" },
    { sessionKey: "agent:ops:main", budget: undefined, otherAgent: "research" },
  ])(
    "creates a goal in the owning store for $sessionKey",
    async ({ sessionKey, budget, otherAgent }) => {
      const { options, readGoal } = await createStoreConfig(sessionKey);
      const tool = createCreateGoalTool(options);
      const args = {
        objective: "ship work",
        ...(budget === undefined ? {} : { token_budget: budget }),
      };
      expect(Value.Check(tool.parameters, args)).toBe(true);
      await tool.execute("call-1", args);
      expect(readGoal()).toMatchObject({
        objective: "ship work",
        ...(budget === undefined ? {} : { tokenBudget: budget }),
      });
      expect(readGoal(otherAgent)).toBeUndefined();
    },
  );

  it.each(["42.9", 0])("rejects invalid token budget %s", async (tokenBudget) => {
    const { options, readGoal } = await createStoreConfig();
    const tool = createCreateGoalTool(options);
    await expect(
      tool.execute("call-invalid-budget", { objective: "ship", token_budget: tokenBudget }),
    ).rejects.toThrow("token_budget must be a positive integer");

    expect(readGoal()).toBeUndefined();
  });

  it("returns actionable guidance when goal is already complete", async () => {
    const { options, readGoal } = await createStoreConfig("global", {
      goal: makeGoal({ status: "complete", tokensUsed: 10 }),
    });
    const tool = createUpdateGoalTool(options);
    const originalGoal = readGoal();

    const result = await tool.execute("call-already-complete", { status: "blocked" });

    expect(result.details).toMatchObject({
      status: "error",
      error: "goal is already complete",
      nextAction: expect.stringContaining("Do not retry update_goal"),
    });
    expect(readGoal()).toEqual(originalGoal);

    const repeated = await tool.execute("call-complete-again", { status: "complete" });
    expect(repeated.details).toMatchObject({
      status: "updated",
      goal: { id: "goal-1", objective: "ship", status: "complete" },
      nextAction: expect.stringContaining("provide the requested visible final response"),
    });
  });

  it("keeps missing-session failures on the generic error path", async () => {
    const dir = tempDirs.make();
    const tool = createUpdateGoalTool({
      agentSessionKey: "global",
      sessionAgentId: "research",
      config: { session: { store: path.join(dir, "{agentId}", "sessions.json") } },
    });

    await expect(tool.execute("call-missing-session", { status: "blocked" })).rejects.toThrow(
      "session not found",
    );
  });
});
