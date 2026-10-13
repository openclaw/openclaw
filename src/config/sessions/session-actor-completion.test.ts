import { expect, it, vi } from "vitest";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import type { SessionActorPendingFinalDelivery } from "./session-actor-contract.js";
import { withActor, type Mutation } from "./session-actor-worker.test-support.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";

// mock-isolation: Actor ownership proof must not schedule unrelated background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture owns its database lifetime without background history eviction.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

it("commits final custody and restart claim cleanup together across a failed commit", async () => {
  await withActor(async (f) => {
    runSqliteImmediateTransactionSync(f.database.db, () => {
      writeSessionEntry(f.database, f.target.sessionKey, {
        ...f.nativeEntry()!,
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
        reducers: [{ kind: "group-intro", needsSystemIntro: false }],
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
    expect(f.mutate(command)).toMatchObject({ kind: "committed" });
    expect(f.hooks.transactions - transactions).toBe(1);
    f.restartActor();
    const after = f.read().entry;
    expect(after).toMatchObject({
      pendingFinalDelivery: pending,
      label: "entry owner committed",
      groupActivationNeedsSystemIntro: false,
      restartRecoveryTerminalRunIds: ["source"],
    });
    expect(after?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(after?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(after?.restartRecoveryRuns).toBeUndefined();
  });
});
