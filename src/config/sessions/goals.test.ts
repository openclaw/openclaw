import { describe, expect, it } from "vitest";
import {
  clearSessionGoal,
  createSessionGoal,
  getSessionGoal,
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
    await writeSession(100);

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
});
