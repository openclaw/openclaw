import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { projectSessionActivitySummary } from "../../gateway/session-activity-summary-state.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  ACTIVITY_SUMMARY_FORMAT_REVISION,
  type SessionActivitySummary,
} from "./activity-summary.js";
import { buildCreatedSessionGoal } from "./goals-transitions.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type {
  SessionActorPendingFinalDelivery,
  SessionActorReducer,
} from "./session-actor-contract.js";
import { withActor, type Fixture, type Mutation } from "./session-actor-worker.test-support.js";
import { buildSessionTranscriptTurnExpectedState } from "./session-transcript-turn-state.js";
import { timedMessageEvent } from "./transcript-message.test-support.js";

// mock-isolation: Actor ownership proof must not schedule unrelated background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture owns its database lifetime without background history eviction.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const usageReducer = {
  kind: "usage",
  updatedAt: 50,
  update: {
    usage: { input: 12, output: 4 },
    modelSelection: {},
    hasContextUpdate: false,
    hasFreshContextSnapshot: false,
    hasCurrentContextSnapshot: false,
    preserveSessionModelState: true,
    preserveUserFacingRunState: false,
  },
} satisfies SessionActorReducer;

type Completion = Extract<Mutation, { type: "session.actor.completeTurn" }>;

function completion(
  f: Fixture,
  commandId: string,
  input: Pick<Completion["input"], "reducers" | "activitySummary" | "pendingFinalDelivery"> & {
    phaseId?: string;
  },
): Completion {
  const before = f.read();
  return {
    type: "session.actor.completeTurn",
    input: {
      target: f.target,
      commandId,
      phaseId: "completion",
      expected: before.version,
      bookkeeping: {
        sessionId: f.scope.sessionId,
        lifecycleRevision: before.entry!.lifecycleRevision ?? null,
        writerRunId: before.entry!.activeWriterRunId,
        expectedState: buildSessionTranscriptTurnExpectedState(before.entry!),
      },
      ...input,
    },
  };
}

function recap(
  f: Fixture,
  text: string,
  leafEntryId: string | null = null,
): SessionActivitySummary {
  const source = f.read();
  return {
    version: 1,
    formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
    text,
    updatedAt: 50,
    sessionId: f.scope.sessionId,
    lifecycleRevision: source.entry!.lifecycleRevision,
    ...source.transcript.watermark,
    leafEntryId,
    coveredMessages: leafEntryId ? 1 : 0,
    totalMessages: leafEntryId ? 1 : 0,
    omittedContent: false,
  };
}

it("commits final custody, recap, usage, together across rollback and restart", async () => {
  await withActor(async (f) => {
    f.writeEntry({
      ...f.nativeEntry()!,
      lifecycleRevision: "completion-lifecycle",
      activeWriterRunId: "writer",
    });
    f.read();
    f.patchEntry({
      selection: { kind: "entry", sessionKey: f.target.sessionKey, exact: true },
      sessionKey: f.target.sessionKey,
      operation: { kind: "fields", patch: { label: "entry owner committed" } },
      operationLabel: "session-entry.patch",
      validateCanonicalKeys: false,
      preserveActivity: true,
    });
    const before = f.read();
    expect(before.entry?.label).toBe("entry owner committed");
    const activitySummary = recap(f, "Completed the synthetic task");
    const pending: SessionActorPendingFinalDelivery = {
      kind: "replayable",
      text: "recoverable final",
      createdAt: 50,
      intentId: "intent",
      deliveries: [{ id: "payload", state: "prepared" }],
    };
    const command = completion(f, "complete-with-cleanup", {
      activitySummary,
      pendingFinalDelivery: pending,
      reducers: [{ kind: "group-intro", needsSystemIntro: false }, usageReducer],
    });
    await f.prepare(command);
    f.hooks.admit = (stage) => {
      if (stage === "commit") {
        throw new Error("synthetic crash before completion commit");
      }
    };
    expect(f.mutate(command)).toMatchObject({ kind: "rolled-back" });
    expect(f.nativeEntry()).toEqual(before.entry);

    delete f.hooks.admit;
    command.input.expected = f.read().version;
    const transactions = f.hooks.transactions;
    const writes = trackSqliteStatementExecutions(f.database.db, ["entry"], (sql) =>
      /^(?:insert into|update) "session_nodes"/iu.test(sql) ? "entry" : null,
    );
    try {
      expect(f.mutate(command)).toMatchObject({
        kind: "committed",
        receipt: { postimage: { entry: { activitySummary, inputTokens: 12, outputTokens: 4 } } },
      });
      expect(writes.counts.entry).toBe(1);
    } finally {
      writes.restore();
    }
    expect(f.hooks.transactions - transactions).toBe(1);
    f.closeActor();
    await f.reopenDatabase();
    f.restartActor();
    const after = f.read().entry;
    expect(after).toMatchObject({
      pendingFinalDelivery: pending,
      label: "entry owner committed",
      groupActivationNeedsSystemIntro: false,
      activitySummary,
      inputTokens: 12,
      outputTokens: 4,
    });
  });
});

it("retains stale recap text but skips another session's recap without losing completion usage", async () => {
  await withActor(async (f) => {
    runSqliteImmediateTransactionSync(f.database.db, () => {
      writeSessionEntry(f.database, f.target.sessionKey, {
        ...f.nativeEntry()!,
        lifecycleRevision: "recap-lifecycle",
      });
      appendTranscriptEventsInTransaction(f.database, f.scope, [
        {
          type: "session",
          id: f.scope.sessionId,
          timestamp: "2026-01-01T00:00:00Z",
        },
        timedMessageEvent("recapped-message", null, "2026-01-01T00:00:01Z", {
          role: "user",
          content: "Summarize this input",
        }),
      ]);
    });
    const activitySummary = recap(f, "The original input", "recapped-message");
    runSqliteImmediateTransactionSync(f.database.db, () =>
      appendTranscriptEventsInTransaction(f.database, f.scope, [
        timedMessageEvent("newer-message", "recapped-message", "2026-01-01T00:00:02Z", {
          role: "assistant",
          content: "New content after the recap started",
        }),
      ]),
    );
    const candidates = [
      activitySummary,
      { ...activitySummary, sessionId: "replaced-session", text: "Another session's text" },
      { ...activitySummary, lifecycleRevision: "replaced-lifecycle", text: "Old lifecycle text" },
    ];
    for (const [index, candidate] of candidates.entries()) {
      const command = completion(f, `complete-recap-${index}`, {
        activitySummary: candidate,
        reducers: [
          {
            ...usageReducer,
            update: { ...usageReducer.update, usage: { input: 12 + index, output: 4 } },
          },
        ],
      });
      await f.prepare(command);
      expect(f.mutate(command)).toMatchObject({ kind: "committed" });
      const after = f.read();
      expect(after.entry).toMatchObject({
        activitySummary,
        inputTokens: 12 + index,
        outputTokens: 4,
      });
      expect(
        projectSessionActivitySummary({
          key: f.target.sessionKey,
          agentId: "main",
          cfg: {},
          entry: after.entry,
          watermark: after.transcript.watermark,
          enabled: true,
        }),
      ).toEqual({ text: activitySummary.text, updatedAt: 50, state: "stale" });
    }
  });
});

it.each(["active", "complete", "replaced", "cleared"] as const)(
  "preserves %s Goal identity and status while accounting a continuation across actor restart",
  async (state) => {
    await withActor(async (f) => {
      const entry = f.nativeEntry()!;
      f.writeEntry({
        ...entry,
        goal:
          state === "cleared"
            ? undefined
            : {
                ...buildCreatedSessionGoal(entry, { objective: "Verify the synthetic fixture" }, 1),
                id: state === "replaced" ? "other-goal" : "admitted-goal",
                status: state === "complete" ? "complete" : "active",
                tokenStart: 0,
                tokenStartFresh: true,
                tokensUsed: 12,
                continuationTurns: 2,
              },
      });
      const before = f.read();
      const command = completion(f, "goal-turn-complete", {
        phaseId: "goal-turn",
        reducers: [{ kind: "goal-continuation", goalId: "admitted-goal" }],
      });
      await f.prepare(command);
      expect(f.mutate(command)).toMatchObject({ kind: "committed" });
      f.restartActor();
      await f.prepare(command);
      const replay = f.mutate(command);
      expect(replay).toMatchObject({ kind: "stale-version" });
      const goal = f.read().entry?.goal;
      if (state === "cleared") {
        expect(goal).toBeUndefined();
      } else {
        expect(goal).toEqual({
          ...before.entry!.goal,
          continuationTurns: state === "replaced" ? 2 : 3,
        });
      }
    });
  },
);
