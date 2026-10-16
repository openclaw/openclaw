import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { projectSessionActivitySummary } from "../../gateway/session-activity-summary-state.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  ACTIVITY_SUMMARY_FORMAT_REVISION,
  type SessionActivitySummary,
} from "./activity-summary.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type {
  SessionActorPendingFinalDelivery,
  SessionActorReducer,
} from "./session-actor-contract.js";
import { withActor, type Mutation } from "./session-actor-worker.test-support.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";

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

it("commits final custody, recap, usage, and claim cleanup together across rollback and restart", async () => {
  await withActor(async (f) => {
    runSqliteImmediateTransactionSync(f.database.db, () => {
      writeSessionEntry(f.database, f.target.sessionKey, {
        ...f.nativeEntry()!,
        lifecycleRevision: "completion-lifecycle",
        activeWriterRunId: "writer",
        restartRecoveryDeliveryRunId: "recovery",
        restartRecoveryDeliverySourceRunId: "source",
        restartRecoveryRuns: [{ runId: "writer", lifecycleGeneration: "generation" }],
      });
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
    const activitySummary: SessionActivitySummary = {
      version: 1,
      formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
      text: "Completed the synthetic task",
      updatedAt: 50,
      sessionId: f.scope.sessionId,
      lifecycleRevision: before.entry!.lifecycleRevision,
      ...before.transcript.watermark,
      leafEntryId: null,
      coveredMessages: 0,
      totalMessages: 0,
      omittedContent: false,
    };
    const pending: SessionActorPendingFinalDelivery = {
      kind: "replayable",
      text: "recoverable final",
      createdAt: 50,
      intentId: "intent",
      deliveries: [{ id: "payload", state: "prepared" }],
    };
    const command: Mutation = {
      type: "session.actor.completeTurn",
      input: {
        target: f.target,
        commandId: "complete-with-cleanup",
        phaseId: "completion",
        expected: before.version,
        bookkeeping: {
          sessionId: f.scope.sessionId,
          lifecycleRevision: before.entry!.lifecycleRevision ?? null,
          writerRunId: "writer",
          expectedState: buildRestartRecoveryExpectedState(before.entry!),
        },
        activitySummary,
        pendingFinalDelivery: pending,
        restartClaimCleanup: {
          kind: "restart-claim-clear",
          expected: {
            sessionId: f.scope.sessionId,
            lifecycleRevision: before.entry!.lifecycleRevision,
          },
          sessionId: f.scope.sessionId,
          recoveryRunId: "recovery",
          recoverySourceRunId: "source",
          executionRunId: "writer",
          executionGeneration: "generation",
        },
        reducers: [{ kind: "group-intro", needsSystemIntro: false }, usageReducer],
      },
    };
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
      restartRecoveryTerminalRunIds: ["source"],
      activitySummary,
      inputTokens: 12,
      outputTokens: 4,
    });
    expect(after?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(after?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(after?.restartRecoveryRuns).toBeUndefined();
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
          version: 3,
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/synthetic",
        },
        {
          type: "message",
          id: "recapped-message",
          parentId: null,
          timestamp: "2026-01-01T00:00:01Z",
          message: { role: "user", content: "Summarize this input" },
        },
      ]);
    });
    const source = f.read();
    const activitySummary: SessionActivitySummary = {
      version: 1,
      formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
      text: "The original input",
      updatedAt: 50,
      sessionId: f.scope.sessionId,
      lifecycleRevision: source.entry!.lifecycleRevision,
      ...source.transcript.watermark,
      leafEntryId: "recapped-message",
      coveredMessages: 1,
      totalMessages: 1,
      omittedContent: false,
    };
    runSqliteImmediateTransactionSync(f.database.db, () =>
      appendTranscriptEventsInTransaction(f.database, f.scope, [
        {
          type: "message",
          id: "newer-message",
          parentId: "recapped-message",
          timestamp: "2026-01-01T00:00:02Z",
          message: { role: "assistant", content: "New content after the recap started" },
        },
      ]),
    );
    const candidates = [
      activitySummary,
      { ...activitySummary, sessionId: "replaced-session", text: "Another session's text" },
      { ...activitySummary, lifecycleRevision: "replaced-lifecycle", text: "Old lifecycle text" },
    ];
    for (const [index, candidate] of candidates.entries()) {
      const before = f.read();
      const command: Mutation = {
        type: "session.actor.completeTurn",
        input: {
          target: f.target,
          commandId: `complete-recap-${index}`,
          phaseId: "completion",
          expected: before.version,
          bookkeeping: {
            sessionId: f.scope.sessionId,
            lifecycleRevision: before.entry!.lifecycleRevision ?? null,
            writerRunId: before.entry!.activeWriterRunId,
            expectedState: buildRestartRecoveryExpectedState(before.entry!),
          },
          activitySummary: candidate,
          reducers: [
            {
              ...usageReducer,
              update: { ...usageReducer.update, usage: { input: 12 + index, output: 4 } },
            },
          ],
        },
      };
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
