// Plan-mode state machine: enter -> plan -> exit -> approve/reject cycles + store roundtrip.
import { describe, expect, it } from "vitest";
import {
  clearPlanState,
  enterPlanMode,
  getSessionPlanState,
  resolveSessionPlanState,
  revisePlanMode,
  setPlanPendingApproval,
} from "./plan-state.js";
import { applySessionStoreMigrations } from "./store-migrations.js";
import { getSessionEntry, upsertSessionEntry } from "./store.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

describe("session plan-mode state", () => {
  const fixture = useTempSessionsFixture("openclaw-session-plan-");
  const sessionKey = "agent:main:telegram:direct:123";

  async function writeSession(): Promise<void> {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: { sessionId: "sess-1", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    });
  }

  it("defaults to inactive when no plan slot exists", async () => {
    await writeSession();
    const snapshot = await getSessionPlanState({ storePath: fixture.storePath(), sessionKey });
    expect(snapshot.status).toBe("inactive");
    expect(snapshot.plan).toBeUndefined();
  });

  it("enters planning and persists a core-owned slot", async () => {
    await writeSession();
    const plan = await enterPlanMode({ storePath: fixture.storePath(), sessionKey, now: 10 });
    expect(plan.status).toBe("planning");
    expect(plan.enteredAt).toBe(10);
    expect(getSessionEntry({ storePath: fixture.storePath(), sessionKey })?.plan?.status).toBe(
      "planning",
    );
  });

  it("is idempotent while already planning", async () => {
    await writeSession();
    const first = await enterPlanMode({ storePath: fixture.storePath(), sessionKey, now: 10 });
    const second = await enterPlanMode({ storePath: fixture.storePath(), sessionKey, now: 99 });
    expect(second.enteredAt).toBe(first.enteredAt);
    expect(second.status).toBe("planning");
  });

  it("transitions planning -> pending_approval with plan file + question id", async () => {
    await writeSession();
    await enterPlanMode({ storePath: fixture.storePath(), sessionKey, now: 10 });
    const pending = await setPlanPendingApproval({
      storePath: fixture.storePath(),
      sessionKey,
      planFilePath: "/tmp/plan.md",
      pendingQuestionId: "plan-approval-main-1",
      summary: "Do the thing",
      now: 20,
    });
    expect(pending.status).toBe("pending_approval");
    expect(pending.planFilePath).toBe("/tmp/plan.md");
    expect(pending.pendingQuestionId).toBe("plan-approval-main-1");
    expect(pending.lastSummary).toBe("Do the thing");
  });

  it("approve clears the slot back to inactive", async () => {
    await writeSession();
    await enterPlanMode({ storePath: fixture.storePath(), sessionKey });
    await setPlanPendingApproval({
      storePath: fixture.storePath(),
      sessionKey,
      planFilePath: "/tmp/plan.md",
      pendingQuestionId: "q-1",
    });
    const removed = await clearPlanState({ storePath: fixture.storePath(), sessionKey });
    expect(removed).toBe(true);
    const snapshot = await getSessionPlanState({ storePath: fixture.storePath(), sessionKey });
    expect(snapshot.status).toBe("inactive");
  });

  it("reject returns to planning and records feedback, clearing the question id", async () => {
    await writeSession();
    await enterPlanMode({ storePath: fixture.storePath(), sessionKey });
    await setPlanPendingApproval({
      storePath: fixture.storePath(),
      sessionKey,
      planFilePath: "/tmp/plan.md",
      pendingQuestionId: "q-1",
    });
    const revised = await revisePlanMode({
      storePath: fixture.storePath(),
      sessionKey,
      feedback: "add tests",
    });
    expect(revised.status).toBe("planning");
    expect(revised.lastFeedback).toBe("add tests");
    expect(revised.pendingQuestionId).toBeUndefined();
  });

  it("refuses to re-enter while awaiting approval", async () => {
    await writeSession();
    await enterPlanMode({ storePath: fixture.storePath(), sessionKey });
    await setPlanPendingApproval({
      storePath: fixture.storePath(),
      sessionKey,
      planFilePath: "/tmp/plan.md",
      pendingQuestionId: "q-1",
    });
    await expect(enterPlanMode({ storePath: fixture.storePath(), sessionKey })).rejects.toThrow(
      /awaiting approval/,
    );
  });

  it("resolveSessionPlanState reads a slot without I/O", () => {
    const entry: Pick<SessionEntry, "plan"> = {
      plan: { schemaVersion: 1, status: "planning", enteredAt: 1, updatedAt: 1 },
    };
    expect(resolveSessionPlanState(entry).status).toBe("planning");
    expect(resolveSessionPlanState({}).status).toBe("inactive");
    expect(resolveSessionPlanState(undefined).status).toBe("inactive");
  });

  it("survives store migration/roundtrip: legacy entries lack a plan slot", () => {
    const store: Record<string, SessionEntry> = {
      [sessionKey]: { sessionId: "s", updatedAt: 1 } as SessionEntry,
    };
    // Migration must not invent a plan slot for legacy entries.
    applySessionStoreMigrations(store);
    expect(store[sessionKey]?.plan).toBeUndefined();
    expect(resolveSessionPlanState(store[sessionKey]).status).toBe("inactive");
  });
});
