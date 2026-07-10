// Session goal tests cover persisted session goal state and transitions.
import { describe, expect, it } from "vitest";
import {
  clearSessionGoal,
  createSessionGoal,
  formatSessionGoalStatus,
  clearSessionGoalWaitBarrier,
  getSessionGoal,
  normalizeSessionGoalContract,
  recordSessionGoalContinuation,
  resetSessionGoalContinuations,
  resolveSessionGoalDisplayState,
  setSessionGoalWaitBarrier,
  updateSessionGoalContract,
  updateSessionGoalObjective,
  updateSessionGoalStatus,
} from "./goals.js";
import { getSessionEntry, upsertSessionEntry } from "./store.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("session goals", () => {
  const fixture = useTempSessionsFixture("openclaw-session-goals-");
  const sessionKey = "agent:main:telegram:direct:123";

  async function writeSession(totalTokens = 0) {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        sessionId: "sess-1",
        updatedAt: 1,
        totalTokens,
        totalTokensFresh: true,
      },
    });
  }

  it("creates core-owned goal state on the session entry", async () => {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        ...getSessionEntry({ storePath: fixture.storePath(), sessionKey })!,
        totalTokens: 100,
      },
    });

    const goal = await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "land the PR",
      tokenBudget: 50,
      now: 10,
    });

    expect(goal.objective).toBe("land the PR");
    expect(goal.status).toBe("active");
    expect(goal.tokenStart).toBe(100);
    expect(goal.tokenStartFresh).toBe(true);
    expect(goal.tokenBudget).toBe(50);
    expect(getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.goal?.id).toBe(goal.id);
  });

  it("can create a goal from a fallback session entry", async () => {
    const goal = await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "native slash start",
      fallbackEntry: {
        sessionId: "sess-1",
        updatedAt: 1,
        totalTokens: 10,
        totalTokensFresh: true,
      },
      now: 10,
    });

    expect(goal.tokenStart).toBe(10);
    expect(getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.goal?.objective).toBe(
      "native slash start",
    );
  });

  it("accounts usage from session token snapshots and enforces budget", async () => {
    await writeSession(100);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "finish task",
      tokenBudget: 20,
      now: 10,
    });
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        ...getSessionEntry({ storePath: fixture.storePath(), sessionKey })!,
        totalTokens: 125,
      },
    });

    const snapshot = await getSessionGoal({ storePath: fixture.storePath(), sessionKey, now: 20 });

    expect(snapshot.goal?.tokensUsed).toBe(25);
    expect(snapshot.goal?.status).toBe("budget_limited");
  });

  it("resumes budget-limited goals with a fresh budget window", async () => {
    await writeSession(100);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "finish task",
      tokenBudget: 20,
      now: 10,
    });
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        ...getSessionEntry({ storePath: fixture.storePath(), sessionKey })!,
        totalTokens: 125,
      },
    });
    await getSessionGoal({ storePath: fixture.storePath(), sessionKey, now: 20 });

    const resumed = await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "active",
      now: 30,
    });
    const snapshot = await getSessionGoal({ storePath: fixture.storePath(), sessionKey, now: 40 });

    expect(resumed.status).toBe("active");
    expect(resumed.tokenStart).toBe(125);
    expect(resumed.tokensUsed).toBe(0);
    expect(snapshot.goal?.status).toBe("active");
    expect(snapshot.goal?.tokensUsed).toBe(0);
  });

  it("requireActiveStatus refuses to complete a goal the user paused (judge guard)", async () => {
    await writeSession();
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "finish task",
      now: 10,
    });
    // User pauses the goal (as could happen mid-judge).
    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "paused",
      now: 20,
    });

    // The goal driver's completion judge tries to complete it; the guard blocks it.
    await expect(
      updateSessionGoalStatus({
        storePath: fixture.storePath(),
        sessionKey,
        status: "complete",
        requireActiveStatus: true,
        now: 30,
      }),
    ).rejects.toThrow(/not active/);

    // The paused status is preserved — the judge did not override it.
    const snapshot = await getSessionGoal({ storePath: fixture.storePath(), sessionKey, now: 40 });
    expect(snapshot.goal?.status).toBe("paused");
  });

  it("requireActiveStatus completes a goal that is still active", async () => {
    await writeSession();
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "finish task",
      now: 10,
    });

    const completed = await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "complete",
      requireActiveStatus: true,
      now: 20,
    });
    expect(completed.status).toBe("complete");
  });

  it("ignores stale token snapshots for budget accounting", async () => {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        sessionId: "sess-1",
        updatedAt: 1,
        totalTokens: 100,
        totalTokensFresh: false,
      },
    });
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "finish task",
      tokenBudget: 20,
      now: 10,
    });
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        ...getSessionEntry({ storePath: fixture.storePath(), sessionKey })!,
        totalTokens: 125,
        totalTokensFresh: false,
      },
    });

    const snapshot = await getSessionGoal({ storePath: fixture.storePath(), sessionKey, now: 20 });

    expect(snapshot.goal?.tokenStart).toBe(0);
    expect(snapshot.goal?.tokenStartFresh).toBe(false);
    expect(snapshot.goal?.tokensUsed).toBe(0);
    expect(snapshot.goal?.status).toBe("active");
  });

  it("adopts the first fresh token snapshot as the baseline after stale goal creation", async () => {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        sessionId: "sess-1",
        updatedAt: 1,
        totalTokens: 100,
        totalTokensFresh: false,
      },
    });
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "finish task",
      tokenBudget: 20,
      now: 10,
    });
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        ...getSessionEntry({ storePath: fixture.storePath(), sessionKey })!,
        totalTokens: 125,
        totalTokensFresh: true,
      },
    });

    const snapshot = await getSessionGoal({ storePath: fixture.storePath(), sessionKey, now: 20 });

    expect(snapshot.goal?.tokenStart).toBe(125);
    expect(snapshot.goal?.tokenStartFresh).toBe(true);
    expect(snapshot.goal?.tokensUsed).toBe(0);
    expect(snapshot.goal?.status).toBe("active");
  });

  it("treats token snapshots as fresh unless explicitly stale", async () => {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        sessionId: "sess-1",
        updatedAt: 1,
        totalTokens: 100,
      },
    });
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "finish task",
      now: 10,
    });
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        ...getSessionEntry({ storePath: fixture.storePath(), sessionKey })!,
        totalTokens: 125,
      },
    });

    const snapshot = await getSessionGoal({ storePath: fixture.storePath(), sessionKey, now: 20 });

    expect(snapshot.goal?.tokenStart).toBe(100);
    expect(snapshot.goal?.tokensUsed).toBe(25);
  });

  it("lets model tools complete or block but keeps existing terminal state", async () => {
    await writeSession(0);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "ship",
      now: 10,
    });

    const completed = await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "complete",
      note: "done",
      now: 20,
    });

    expect(completed.status).toBe("complete");
    expect(completed.lastStatusNote).toBe("done");
    await expect(
      updateSessionGoalStatus({
        storePath: fixture.storePath(),
        sessionKey,
        status: "blocked",
        now: 30,
      }),
    ).rejects.toThrow(/already complete/);
  });

  it("lets users resume blocked goals", async () => {
    await writeSession(0);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "ship",
      now: 10,
    });

    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "blocked",
      note: "waiting on CI",
      now: 20,
    });
    const resumed = await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "active",
      now: 30,
    });

    expect(resumed.status).toBe("active");
    expect(resumed.lastStatusNote).toBe("waiting on CI");
  });

  it("resumes paused goals with a fresh budget window after usage passes the budget", async () => {
    await writeSession(0);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "ship",
      tokenBudget: 20,
      now: 10,
    });
    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "paused",
      now: 20,
    });
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: {
        ...getSessionEntry({ storePath: fixture.storePath(), sessionKey })!,
        totalTokens: 100,
      },
    });

    const resumed = await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "active",
      now: 30,
    });

    expect(resumed.status).toBe("active");
    expect(resumed.tokenStart).toBe(100);
    expect(resumed.tokensUsed).toBe(0);
    expect(resumed.budgetLimitedAt).toBeUndefined();
  });

  it("formats a readable status summary with command hints", () => {
    const text = formatSessionGoalStatus({
      schemaVersion: 1,
      id: "goal-1",
      objective: "land the PR",
      status: "blocked",
      createdAt: 1,
      updatedAt: 2,
      tokenStart: 0,
      tokensUsed: 12_000,
      tokenBudget: 30_000,
      continuationTurns: 0,
      lastStatusNote: "waiting on review",
    });

    expect(text).toContain("Goal\nStatus: blocked\nObjective: land the PR");
    expect(text).toContain("Token budget: 12k/30k");
    expect(text).toContain("Commands: /goal resume, /goal edit <objective>, /goal clear");
  });

  it("durably records and resets the no-progress continuation counter (survives reload)", async () => {
    await writeSession(0);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "ship the feature",
    });

    // Two driver fires increment the durable counter.
    await recordSessionGoalContinuation({ storePath: fixture.storePath(), sessionKey });
    await recordSessionGoalContinuation({ storePath: fixture.storePath(), sessionKey });

    // Re-read from disk (a fresh read == a gateway restart) proves durability.
    expect(
      getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.goal?.continuationTurns,
    ).toBe(2);

    // A real inbound turn resets the counter durably.
    const reset = await resetSessionGoalContinuations({
      storePath: fixture.storePath(),
      sessionKey,
    });
    expect(reset?.continuationTurns).toBe(0);
    expect(
      getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.goal?.continuationTurns,
    ).toBe(0);
  });

  it("does not increment the continuation counter for a non-active goal", async () => {
    await writeSession(0);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "ship the feature",
    });
    await updateSessionGoalStatus({ storePath: fixture.storePath(), sessionKey, status: "paused" });

    const result = await recordSessionGoalContinuation({
      storePath: fixture.storePath(),
      sessionKey,
    });
    expect(result).toBeUndefined();
    expect(
      getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.goal?.continuationTurns,
    ).toBe(0);
  });

  it("rewords the objective without touching status or token accounting", async () => {
    await writeSession(100);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "ship the fix",
      tokenBudget: 50,
      now: 10,
    });

    const updated = await updateSessionGoalObjective({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "ship the fix and update docs",
      now: 20,
    });

    expect(updated.objective).toBe("ship the fix and update docs");
    expect(updated.status).toBe("active");
    expect(updated.tokenStart).toBe(100);
    expect(updated.tokenBudget).toBe(50);
    expect(updated.updatedAt).toBe(20);
    expect(getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.goal?.objective).toBe(
      "ship the fix and update docs",
    );
  });

  it("rejects rewording terminal or missing goals", async () => {
    await writeSession(0);
    await expect(
      updateSessionGoalObjective({
        storePath: fixture.storePath(),
        sessionKey,
        objective: "anything",
        now: 10,
      }),
    ).rejects.toThrow(/goal not found/);

    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "ship",
      now: 10,
    });
    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "complete",
      now: 20,
    });

    await expect(
      updateSessionGoalObjective({
        storePath: fixture.storePath(),
        sessionKey,
        objective: "new target",
        now: 30,
      }),
    ).rejects.toThrow(/already complete/);
  });

  it("projects display state from fresh session tokens", () => {
    const goal = resolveSessionGoalDisplayState(
      {
        totalTokens: 140,
        totalTokensFresh: true,
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "finish",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 100,
          tokensUsed: 0,
          tokenBudget: 40,
          continuationTurns: 0,
        },
      },
      20,
    );

    expect(goal?.tokensUsed).toBe(40);
    expect(goal?.status).toBe("budget_limited");
  });

  it("can project without adopting a stale baseline for read-only displays", () => {
    const goal = resolveSessionGoalDisplayState(
      {
        totalTokens: 140,
        totalTokensFresh: true,
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "finish",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokenStartFresh: false,
          tokensUsed: 0,
          tokenBudget: 40,
          continuationTurns: 0,
        },
      },
      20,
      { adoptFreshBaseline: false },
    );

    expect(goal?.tokenStart).toBe(0);
    expect(goal?.tokenStartFresh).toBe(false);
    expect(goal?.tokensUsed).toBe(0);
    expect(goal?.status).toBe("active");
  });

  it("clears goal state", async () => {
    await writeSession(0);
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "ship",
      now: 10,
    });

    await expect(clearSessionGoal({ storePath: fixture.storePath(), sessionKey })).resolves.toBe(
      true,
    );
    expect(getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.goal).toBeUndefined();
  });

  describe("completion contract", () => {
    it("normalizes contracts by dropping empty fields and blank list items", () => {
      expect(normalizeSessionGoalContract(undefined)).toBeUndefined();
      expect(normalizeSessionGoalContract({ outcome: "   ", constraints: ["  "] })).toBeUndefined();
      expect(
        normalizeSessionGoalContract({
          outcome: "  done  ",
          verification: "",
          constraints: ["keep tests green", "  ", ""],
          boundaries: [],
          stopWhen: "needs sign-off",
        }),
      ).toEqual({
        outcome: "done",
        constraints: ["keep tests green"],
        stopWhen: "needs sign-off",
      });
    });

    it("persists a contract supplied at create time", async () => {
      await writeSession(0);
      const goal = await createSessionGoal({
        storePath: fixture.storePath(),
        sessionKey,
        objective: "ship",
        now: 10,
        contract: { verification: "the suite passes", constraints: ["  ", "no schema change"] },
      });
      expect(goal.contract).toEqual({
        verification: "the suite passes",
        constraints: ["no schema change"],
      });
    });

    it("attaches then clears a contract via updateSessionGoalContract", async () => {
      await writeSession(0);
      await createSessionGoal({
        storePath: fixture.storePath(),
        sessionKey,
        objective: "ship",
        now: 10,
      });

      const attached = await updateSessionGoalContract({
        storePath: fixture.storePath(),
        sessionKey,
        now: 20,
        contract: { outcome: "auth uses JWT", boundaries: ["services/auth"] },
      });
      expect(attached.contract).toEqual({
        outcome: "auth uses JWT",
        boundaries: ["services/auth"],
      });

      const cleared = await updateSessionGoalContract({
        storePath: fixture.storePath(),
        sessionKey,
        now: 30,
        contract: undefined,
      });
      expect(cleared.contract).toBeUndefined();
    });
  });

  describe("wait barrier", () => {
    async function activeGoal() {
      await writeSession(0);
      await createSessionGoal({
        storePath: fixture.storePath(),
        sessionKey,
        objective: "ship",
        now: 10,
      });
    }

    it("sets a time barrier and clears it", async () => {
      await activeGoal();
      const parked = await setSessionGoalWaitBarrier({
        storePath: fixture.storePath(),
        sessionKey,
        now: 100,
        waitingUntil: 100 + 5_000,
        reason: "CI running",
      });
      expect(parked?.wait?.waitingUntil).toBe(100 + 5_000);
      expect(parked?.wait?.waitingReason).toBe("CI running");
      expect(parked?.wait?.waitingSince).toBe(100);

      const unparked = await clearSessionGoalWaitBarrier({
        storePath: fixture.storePath(),
        sessionKey,
        now: 200,
      });
      expect(unparked?.wait).toBeUndefined();
    });

    it("prefers a session barrier over a time barrier when both are supplied", async () => {
      await activeGoal();
      const parked = await setSessionGoalWaitBarrier({
        storePath: fixture.storePath(),
        sessionKey,
        now: 100,
        waitingUntil: 100 + 5_000,
        waitingOnSessionKey: "agent:main:cron:build",
      });
      expect(parked?.wait?.waitingOnSessionKey).toBe("agent:main:cron:build");
      expect(parked?.wait?.waitingUntil).toBeUndefined();
    });

    it("rejects an already-passed time barrier and requires an active goal", async () => {
      await activeGoal();
      const past = await setSessionGoalWaitBarrier({
        storePath: fixture.storePath(),
        sessionKey,
        now: 100,
        waitingUntil: 50,
      });
      expect(past).toBeUndefined();

      // A non-active goal cannot be parked.
      await updateSessionGoalStatus({
        storePath: fixture.storePath(),
        sessionKey,
        status: "paused",
        now: 110,
      });
      const parkedPaused = await setSessionGoalWaitBarrier({
        storePath: fixture.storePath(),
        sessionKey,
        now: 120,
        waitingUntil: 120 + 5_000,
      });
      expect(parkedPaused).toBeUndefined();
    });

    it("drops the barrier when the goal changes status", async () => {
      await activeGoal();
      await setSessionGoalWaitBarrier({
        storePath: fixture.storePath(),
        sessionKey,
        now: 100,
        waitingOnSessionKey: "agent:main:cron:build",
      });
      const paused = await updateSessionGoalStatus({
        storePath: fixture.storePath(),
        sessionKey,
        status: "paused",
        now: 200,
      });
      expect(paused.wait).toBeUndefined();
    });
  });
});
