import { describe, expect, it } from "vitest";
import {
  clearSessionGoal,
  createSessionGoal,
  formatSessionGoalStatus,
  getSessionGoal,
  resolveSessionGoalDisplayState,
  updateSessionGoalObjective,
  updateSessionGoalStatus,
} from "./goals.js";
import { loadSessionEntry, upsertSessionEntryCore } from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry, type SessionGoal } from "./types.js";

const goalState = (overrides: Partial<SessionGoal> = {}): SessionGoal => ({
  schemaVersion: 1,
  id: "goal-1",
  objective: "finish",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
  tokenStart: 0,
  tokensUsed: 0,
  continuationTurns: 0,
  ...overrides,
});

describe("session goals", () => {
  const fixture = useTempSessionsFixture("openclaw-session-goals-");
  const sessionKey = "agent:main:telegram:direct:123";

  const scope = () => ({ storePath: fixture.storePath(), sessionKey });
  const readEntry = () => loadSessionEntry(scope());
  const writeEntry = (entry: SessionEntry) => upsertSessionEntryCore(scope(), entry);
  type GoalOptions = Omit<Parameters<typeof createSessionGoal>[0], "storePath" | "sessionKey">;
  const createGoal = (options: GoalOptions) =>
    createSessionGoal({ ...scope(), now: 10, ...options });
  const setStatus = (
    status: Parameters<typeof updateSessionGoalStatus>[0]["status"],
    now: number,
    note?: string,
  ) => updateSessionGoalStatus({ ...scope(), status, now, note });

  const sessionEntry = (totalTokens = 0): SessionEntry => ({
    sessionId: "sess-1",
    updatedAt: 1,
    totalTokens,
    totalTokensFresh: true,
    totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
  });
  const writeSession = (totalTokens = 0) => writeEntry(sessionEntry(totalTokens));
  const patchEntry = (patch: Partial<SessionEntry>) => writeEntry({ ...readEntry()!, ...patch });
  const snapshot = (now: number) => getSessionGoal({ ...scope(), now });
  const edit = (objective: string, now: number) =>
    updateSessionGoalObjective({ ...scope(), objective, now });
  async function startGoal(totalTokens = 0, options: Partial<GoalOptions> = {}) {
    await writeSession(totalTokens);
    return createGoal({ objective: "ship", ...options });
  }

  it("creates core-owned goal state on the session entry", async () => {
    await patchEntry({
      totalTokens: 100,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    });
    const goal = await createGoal({ objective: "  land the PR \n", tokenBudget: 50 });
    expect(goal).toMatchObject({
      objective: "land the PR",
      status: "active",
      tokenStart: 100,
      tokenStartFresh: true,
      tokenBudget: 50,
    });
    expect(readEntry()?.goal?.id).toBe(goal.id);
  });

  it("can create a goal from a fallback session entry", async () => {
    const goal = await createGoal({
      objective: "native slash start",
      fallbackEntry: sessionEntry(10),
    });
    expect(goal.tokenStart).toBe(10);
    expect(readEntry()?.goal?.objective).toBe("native slash start");
  });

  it("resumes budget-limited goals with a fresh budget window", async () => {
    await startGoal(100, { objective: "finish task", tokenBudget: 20 });
    await patchEntry({ totalTokens: 125 });
    await snapshot(20);
    const resumed = await setStatus("active", 30);
    expect(resumed).toMatchObject({ status: "active", tokenStart: 125, tokensUsed: 0 });
    expect(resumed.budgetLimitedAt).toBeUndefined();
    expect((await snapshot(40)).goal).toMatchObject({ status: "active", tokensUsed: 0 });
  });

  it("adopts the first fresh token snapshot as the baseline after stale goal creation", async () => {
    await writeEntry({
      ...sessionEntry(100),
      totalTokensFresh: false,
      totalTokensVersion: undefined,
    });
    await createGoal({ objective: "finish task", tokenBudget: 20 });
    await patchEntry({
      totalTokens: 125,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    });
    expect((await snapshot(20)).goal).toMatchObject({
      tokenStart: 125,
      tokenStartFresh: true,
      tokensUsed: 0,
      status: "active",
    });
  });

  it("lets model tools complete or block but keeps existing terminal state", async () => {
    await startGoal();
    const completed = await setStatus("complete", 20, "done");
    expect(completed).toMatchObject({ status: "complete", lastStatusNote: "done" });
    const repeated = await setStatus("complete", 30, "verified");
    expect(repeated).toMatchObject({
      completedAt: completed.completedAt,
      lastStatusNote: "verified",
    });
    expect(readEntry()?.goal?.completedAt).toBe(completed.completedAt);
    await expect(setStatus("blocked", 30)).rejects.toThrow(/already complete/);
  });

  it.each([
    { totalTokens: 105, tokenStart: 100, tokensUsed: 5 },
    { totalTokens: 125, tokenStart: 125, tokensUsed: 0 },
  ])(
    "resumes completed goals with appropriate accounting at $totalTokens tokens",
    async ({ totalTokens, tokenStart, tokensUsed }) => {
      const created = await startGoal(100, { tokenBudget: 20 });
      await patchEntry({ totalTokens });
      const completed = await setStatus("complete", 20, "verified");
      expect(formatSessionGoalStatus(completed)).toContain("Commands: /goal resume, /goal clear");
      const resumed = await setStatus("active", 30);
      expect(resumed).toMatchObject({
        ...created,
        updatedAt: 30,
        tokenStart,
        tokensUsed,
        lastStatusNote: "verified",
      });
      expect(resumed.completedAt).toBeUndefined();
      const recompleted = await setStatus("complete", 40);
      expect(recompleted.completedAt).toBe(40);
      expect(readEntry()?.goal?.completedAt).toBe(40);
    },
  );

  it("lets users resume blocked goals", async () => {
    await startGoal();
    await setStatus("blocked", 20, "waiting on CI");
    const resumed = await setStatus("active", 30);
    expect(resumed).toMatchObject({ status: "active", lastStatusNote: "waiting on CI" });
  });

  it("formats a readable status summary with command hints", () => {
    const text = formatSessionGoalStatus(
      goalState({
        objective: "land the PR",
        status: "blocked",
        updatedAt: 2,
        tokensUsed: 12_000,
        tokenBudget: 30_000,
        lastStatusNote: "waiting on review",
      }),
    );
    expect(text).toContain("Goal\nStatus: blocked\nObjective: land the PR");
    expect(text).toContain("Token budget: 12k/30k");
    expect(text).toContain("Commands: /goal resume, /goal edit <objective>, /goal clear");
  });

  it("rewords the objective without touching status or token accounting", async () => {
    const created = await startGoal(100, { objective: "ship the fix", tokenBudget: 50 });
    const updated = await edit("\tship the fix and update docs \n", 20);
    expect(updated).toMatchObject({
      ...created,
      objective: "ship the fix and update docs",
      updatedAt: 20,
    });
    expect(readEntry()?.goal?.objective).toBe("ship the fix and update docs");
  });

  it("rejects rewording terminal or missing goals", async () => {
    await writeSession(0);
    await expect(edit("anything", 10)).rejects.toThrow(/goal not found/);
    await createGoal({ objective: "ship" });
    await setStatus("complete", 20);
    await expect(edit("new target", 30)).rejects.toThrow(/already complete/);
  });

  it("can project without adopting a stale baseline for read-only displays", () => {
    const goal = resolveSessionGoalDisplayState(
      {
        totalTokens: 140,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        goal: goalState({ tokenStartFresh: false, tokenBudget: 40 }),
      },
      20,
      { adoptFreshBaseline: false },
    );
    expect(goal).toMatchObject({
      tokenStart: 0,
      tokenStartFresh: false,
      tokensUsed: 0,
      status: "active",
    });
  });

  it("clears goal state", async () => {
    await startGoal();
    await expect(clearSessionGoal(scope())).resolves.toBe(true);
    expect(readEntry()?.goal).toBeUndefined();
  });
});
