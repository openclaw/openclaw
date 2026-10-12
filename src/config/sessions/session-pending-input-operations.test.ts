import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import {
  isSqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { readWithdrawnUserTurnInputId } from "../../sessions/user-turn-transcript-admission.js";
import { completeUserTurnProcessing } from "../../sessions/user-turn-transcript-processing.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  ensureSessionInputCompletionsSchema,
  ensureSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import { mutatePendingInput, readPendingInput } from "./session-pending-input-operations.kernel.js";
import type { PendingInputMutation } from "./session-pending-input-operations.types.js";

const scope = {
  agentId: "main",
  sessionKey: "agent:main:pending-worker-settlement",
  sessionId: "pending-worker-settlement",
};
const message = (runId: string) => ({
  role: "user" as const,
  content: `Synthetic pending input ${runId}`,
  timestamp: 1,
  idempotencyKey: `${runId}:user`,
});

function createFixture() {
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
  writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
  return {
    database,
    stage: async (runId: string, assertCurrent = () => {}, trackCompletion = false) =>
      expectDefined(
        await stageSessionPendingInput(scope, {
          runId,
          message: message(runId),
          assertCurrent,
          trackCompletion,
        }),
        "Expected accepted input custody",
      ),
    pending: () =>
      database.db
        .prepare("SELECT run_id, state, request_hash FROM session_pending_inputs ORDER BY seq")
        .all(),
  };
}

it("shares transaction rows without retaining stale custody and returns the persisted staging postimage", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { database } = createFixture();
    ensureSessionPendingInputsSchema(database.db);
    ensureSessionInputCompletionsSchema(database.db);
    const identity = {
      ...scope,
      idempotencyKey: "cohort:user",
      runId: "cohort",
      requestHash: "cohort-hash",
      lifecycleGeneration: "cohort-generation",
      authorityAgentId: "main",
    };
    const read = () => {
      const snapshot = runSqliteReadSnapshotSync(database.db, () =>
        readPendingInput(database, { ...identity, kind: "stage", trackCompletion: true }),
      );
      if (snapshot.kind !== "stage") {
        throw new Error("Expected staging snapshot");
      }
      return snapshot;
    };
    const grants: unknown[] = [];
    const mutate = (input: PendingInputMutation) =>
      mutatePendingInput(
        input,
        {
          admit: (stage, facts) => grants.push({ stage, facts: structuredClone(facts) }),
          writeTransaction: (_label, _owner, run) =>
            runOpenClawAgentWriteTransaction(run, { agentId: "main" }),
        },
        () => {},
      );
    const stage = (expected = read()): PendingInputMutation => ({
      ...identity,
      kind: "stage",
      expected,
      trackCompletion: true,
      inputId: "cohort-input",
      messageJson: JSON.stringify(message("cohort")),
    });
    const input = stage();
    database.db
      .prepare(
        "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, ?, ?, ?)",
      )
      .run(scope.sessionKey, "new-member", "owner", 2);
    const counter = trackSqliteStatementExecutions(
      database.db,
      ["entry", "members", "pending", "completion"],
      (sql) => {
        if (/\bfrom "session_nodes"/iu.test(sql)) {
          return "entry";
        }
        if (/\bfrom "session_members"/iu.test(sql)) {
          return "members";
        }
        if (/\bfrom "session_pending_inputs"/iu.test(sql)) {
          return "pending";
        }
        if (/\bfrom "session_input_completions"/iu.test(sql)) {
          return "completion";
        }
        return null;
      },
    );
    let staged;
    try {
      staged = mutate(input);
      expect(counter.counts).toEqual({ entry: 1, members: 1, pending: 1, completion: 1 });
    } finally {
      counter.restore();
    }
    expect(staged.stagedInput).toEqual(
      database.db
        .prepare("SELECT * FROM session_pending_inputs WHERE input_id = ?")
        .get("cohort-input"),
    );
    expect(grants).toMatchObject([
      {
        stage: "transaction",
        facts: {
          candidate: undefined,
          authority: {
            entry: { sessionId: scope.sessionId },
            members: [{ identityId: "new-member" }],
          },
        },
      },
      {
        stage: "commit",
        facts: { receipt: { stagedInput: { input_id: "cohort-input", state: "queued" } } },
      },
    ]);

    const stale = stage();
    database.db
      .prepare("UPDATE session_pending_inputs SET request_hash = ? WHERE input_id = ?")
      .run("replacement", "cohort-input");
    expect(() => mutate(stale)).toThrow("changed before staging committed");
    database.db
      .prepare("UPDATE session_pending_inputs SET request_hash = ? WHERE input_id = ?")
      .run(identity.requestHash, "cohort-input");
    const requeued = mutate(stage());
    expect(requeued.stagedInput).toEqual(staged.stagedInput);

    const completionCounter = trackSqliteStatementExecutions(database.db, ["completion"], (sql) =>
      /\bfrom "session_input_completions"/iu.test(sql) ? "completion" : null,
    );
    const outcome = buildAgentRunTerminalOutcome({ status: "ok" });
    try {
      expect(mutate({ ...identity, kind: "complete", outcome }).outcome).toEqual(outcome);
      expect(completionCounter.counts.completion).toBe(1);
    } finally {
      completionCounter.restore();
    }
    expect(() => mutate({ ...identity, requestHash: "other", kind: "complete", outcome })).toThrow(
      "Input completion conflicts with the accepted input",
    );
    const previous = read();
    writeSessionEntry(database, scope.sessionKey, {
      sessionId: "replacement-session",
      updatedAt: 2,
    });
    expect(() => mutate(stage(previous))).toThrow("no longer owns the admitted session");
  });
});

it("stages and settles an agent user-turn recorder without caller-thread SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createFixture();
    const recorder = createUserTurnTranscriptRecorder({
      message: message("completed"),
      trackInputCompletion: true,
      target: {
        ...scope,
        storePath: fixture.database.path,
        sessionEntry: { sessionId: scope.sessionId, updatedAt: 1 },
      },
    });
    let cancelled: SessionPendingInputReceipt | undefined;
    const sql = observeHostDataSql();
    try {
      expect(await recorder.stageApproved?.({ runId: "completed", assertCurrent: () => {} })).toBe(
        true,
      );
      expect(sql.queries).toEqual([]);
      const cancelledReceipt = await fixture.stage("cancelled");
      cancelled = cancelledReceipt;
      const outcome = buildAgentRunTerminalOutcome({ status: "ok" });
      expect(await completeUserTurnProcessing(recorder, outcome)).toEqual(outcome);
      expect(recorder.getProcessingCompletion?.()).toEqual(outcome);
      recorder.finishPendingInput?.("interrupted");
      cancelledReceipt.finish("cancelled");
      expect(() => cancelledReceipt.run(() => {})).toThrow(SessionPendingInputCustodyError);
      await Promise.all([recorder.waitForPendingInputSettlement?.(), cancelledReceipt.settled?.()]);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      recorder.finishPendingInput?.("interrupted");
      cancelled?.finish("interrupted");
      await Promise.all([recorder.waitForPendingInputSettlement?.(), cancelled?.settled?.()]);
    }
    expect(fixture.pending()).toEqual([
      expect.objectContaining({ run_id: "cancelled", state: "cancelled" }),
    ]);
    expect(
      fixture.database.db.prepare("SELECT run_id, succeeded FROM session_input_completions").all(),
    ).toEqual([{ run_id: "completed", succeeded: 1 }]);
  });
});

it.each(["cancelled", "consumed", "failed"] as const)(
  "reports a withdrawn input only after confirmed cancellation: %s",
  async (result) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = createFixture();
      const recorder = createUserTurnTranscriptRecorder({
        message: message(result),
        target: {
          ...scope,
          storePath: fixture.database.path,
          sessionEntry: { sessionId: scope.sessionId, updatedAt: 1 },
        },
      });
      await recorder.stageApproved?.({ runId: result, assertCurrent: () => {} });
      const pending = expectDefined(
        (await listSessionPendingInputs(scope)).items[0],
        "Expected accepted input",
      );
      expect(readWithdrawnUserTurnInputId(recorder)).toBeUndefined();
      if (result === "consumed") {
        await recorder.persistApproved();
        expect(recorder.isPendingInputConsumed?.()).toBe(true);
      }
      const spy = probe.admission(admission, (request, grant, callback) => {
        const facts = request.facts;
        if (
          result === "failed" &&
          request.stage === "commit" &&
          isRecord(facts) &&
          isRecord(facts.publication) &&
          isRecord(facts.publication.receipt) &&
          facts.publication.receipt.operation === "finish"
        ) {
          throw new Error("Synthetic cancellation commit refused");
        }
        callback(request, grant);
      });
      try {
        recorder.finishPendingInput?.("cancelled");
        expect(readWithdrawnUserTurnInputId(recorder)).toBeUndefined();
        if (result === "failed") {
          await expect(recorder.waitForPendingInputSettlement?.()).rejects.toThrow(
            "Synthetic cancellation commit refused",
          );
        } else {
          await recorder.waitForPendingInputSettlement?.();
        }
        expect(readWithdrawnUserTurnInputId(recorder)).toBe(
          result === "cancelled" ? pending.id : undefined,
        );
        expect(fixture.pending()).toEqual(
          result === "consumed"
            ? []
            : [
                expect.objectContaining({
                  run_id: result,
                  state: result === "failed" ? "queued" : "cancelled",
                }),
              ],
        );
      } finally {
        spy.mockRestore();
        recorder.finishPendingInput?.("interrupted");
        await Promise.allSettled([recorder.waitForPendingInputSettlement?.()]);
      }
    });
  },
);

it("retains cancellation disposition custody while accepted processing completion is waiting", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createFixture();
    const receipt = await fixture.stage("cancelling", () => {}, true);
    await listSessionPendingInputs(scope);
    const entered = createDeferred();
    const release = createDeferred();
    const original = workerStore.runSqliteWorkerStoreOperation;
    const spy = vi
      .spyOn(workerStore, "runSqliteWorkerStoreOperation")
      .mockImplementation(
        <Operations extends SqliteWorkerOperations, T>(
          target: SqliteWorkerStore<Operations>,
          operation: (worker: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
          stateContext?: Parameters<typeof original>[2],
          assertCurrent?: Parameters<typeof original>[3],
          createAdmission?: Parameters<typeof original>[4],
        ) =>
          original(
            target,
            (worker) =>
              operation({
                execute: async (command, options) => {
                  if (
                    command.type === "session.pendingInputs.mutate" &&
                    isRecord(command.input) &&
                    command.input.kind === "complete"
                  ) {
                    entered.resolve();
                    await release.promise;
                  }
                  return worker.execute(command, options);
                },
              }),
            stateContext,
            assertCurrent,
            createAdmission,
          ),
      );
    const outcome = buildAgentRunTerminalOutcome({
      status: "error",
      error: "Synthetic retryable provider failure",
    });
    const completion = expectDefined(receipt.completeAsync?.(outcome), "Expected async completion");
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, completion, "Completion skipped its worker"),
        signal,
      );
      receipt.finish("cancelled");
      expect(() => receipt.run(() => {})).toThrow(SessionPendingInputCustodyError);
      expect(await withinTest(listSessionPendingInputs(scope), signal)).toMatchObject({
        items: [{ id: receipt.inputId, state: "queued" }],
      });
      release.resolve();
      expect(await completion).toEqual(outcome);
      await receipt.settled?.();
      expect(await listSessionPendingInputs(scope)).toMatchObject({
        items: [{ id: receipt.inputId, state: "cancelled" }],
      });
    } finally {
      release.resolve();
      spy.mockRestore();
      receipt.finish("cancelled");
      await Promise.allSettled([completion, receipt.settled?.()]);
    }
  });
});

it.each(["transaction", "commit"] as const)(
  "refuses a staging grant when the run ends at %s without publishing input custody",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = createFixture();
      let current = true;
      let revoked = false;
      const spy = probe.admission(admission, (request, grant, callback) => {
        const facts = request.facts;
        if (
          request.stage === phase &&
          isRecord(facts) &&
          isRecord(facts.publication) &&
          facts.publication.kind === "pending-input-settlement-custody"
        ) {
          current = false;
          revoked = true;
        }
        callback(request, grant);
      });
      try {
        await expect(
          fixture.stage("ended", () => {
            if (!current) {
              throw new SessionPendingInputCustodyError("Synthetic run ended during admission");
            }
          }),
        ).rejects.toBeInstanceOf(SessionPendingInputCustodyError);
        expect(revoked).toBe(true);
        expect(fixture.pending()).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });
  },
);

it("rejects a worker-side request-hash mismatch with the original custody error class", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createFixture();
    const receipt = await fixture.stage("hash-bound", () => {}, true);
    const original = fixture.pending();
    const originalHash = original[0]?.request_hash;
    fixture.database.db
      .prepare("UPDATE session_pending_inputs SET request_hash = ? WHERE input_id = ?")
      .run("another-request", receipt.inputId);
    try {
      await expect(
        receipt.completeAsync?.(buildAgentRunTerminalOutcome({ status: "ok" })),
      ).rejects.toBeInstanceOf(SessionPendingInputCustodyError);
      expect(fixture.database.db.prepare("SELECT * FROM session_input_completions").all()).toEqual(
        [],
      );
      expect(fixture.pending()).toEqual([{ ...original[0], request_hash: "another-request" }]);
    } finally {
      fixture.database.db
        .prepare("UPDATE session_pending_inputs SET request_hash = ? WHERE input_id = ?")
        .run(originalHash ?? null, receipt.inputId);
      receipt.finish("interrupted");
      await expect(receipt.settled?.()).rejects.toBeInstanceOf(SessionPendingInputCustodyError);
    }
  });
});

it("refuses processing completion when the admitted lifecycle changes during the worker wait", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createFixture();
    const receipt = await fixture.stage("stale-lifecycle", () => {}, true);
    let rotated = false;
    const spy = probe.admission(admission, (request, grant, callback) => {
      const facts = request.facts;
      if (
        request.stage === "transaction" &&
        isRecord(facts) &&
        isRecord(facts.publication) &&
        isRecord(facts.publication.receipt) &&
        facts.publication.receipt.operation === "complete"
      ) {
        rotateAgentEventLifecycleGeneration();
        rotated = true;
      }
      callback(request, grant);
    });
    try {
      await expect(
        receipt.completeAsync?.(buildAgentRunTerminalOutcome({ status: "ok" })),
      ).rejects.toThrow();
      expect(rotated).toBe(true);
      expect(fixture.database.db.prepare("SELECT * FROM session_input_completions").all()).toEqual(
        [],
      );
    } finally {
      spy.mockRestore();
      receipt.finish("interrupted");
      await expect(receipt.settled?.()).rejects.toThrow();
    }
  });
});

it.each(["lost reply", "unknown settlement", "independent committed write"] as const)(
  "settles staging with %s without replaying its native write",
  async (fault) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = createFixture();
      const original = workerStore.runSqliteWorkerStoreOperation;
      let executions = 0;
      let restoreSettlement: (() => void) | undefined;
      const spy = vi
        .spyOn(workerStore, "runSqliteWorkerStoreOperation")
        .mockImplementation(
          <Operations extends SqliteWorkerOperations, T>(
            target: SqliteWorkerStore<Operations>,
            operation: (worker: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
            stateContext?: Parameters<typeof original>[2],
            assertCurrent?: Parameters<typeof original>[3],
            createAdmission?: Parameters<typeof original>[4],
          ) => {
            let staging = false;
            let nativeAdmission: admission.SqliteWorkerOperationAdmission | undefined;
            return original(
              target,
              (worker) =>
                operation({
                  execute: async (command, options) => {
                    staging =
                      command.type === "session.pendingInputs.mutate" &&
                      isRecord(command.input) &&
                      command.input.kind === "stage";
                    const result = await worker.execute(command, options);
                    if (!staging) {
                      return result;
                    }
                    executions++;
                    expect(nativeAdmission?.committed).toMatchObject({
                      facts: { kind: "pending-input-settlement", operation: "stage" },
                    });
                    expect(nativeAdmission?.settlement?.kind).toBe("completed");
                    if (fault === "independent committed write") {
                      runOpenClawAgentWriteTransaction(
                        (database) => {
                          writeSessionEntry(database, "agent:main:independent-input", {
                            sessionId: "independent-input",
                            updatedAt: 2,
                          });
                        },
                        { agentId: scope.agentId },
                      );
                      return result;
                    }
                    if (fault === "unknown settlement") {
                      const observed = expectDefined(nativeAdmission, "Expected native admission");
                      const settlement = vi
                        .spyOn(observed, "settlement", "get")
                        .mockReturnValue({ ...observed.settlement, kind: "unknown" });
                      restoreSettlement = () => settlement.mockRestore();
                    }
                    throw new Error("Synthetic staging reply lost after native write");
                  },
                }),
              stateContext,
              assertCurrent,
              createAdmission &&
                ((retained) => {
                  const owned = createAdmission(retained);
                  if (staging) {
                    nativeAdmission = owned.admission;
                  }
                  return owned;
                }),
            );
          },
        );
      let receipt: SessionPendingInputReceipt | undefined;
      try {
        const result = await fixture.stage("lost-result").then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        expect(executions).toBe(1);
        expect(fixture.pending()).toEqual([
          expect.objectContaining({ run_id: "lost-result", state: "queued" }),
        ]);
        if (fault === "unknown settlement") {
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(isSqliteWorkerError(result.error, "outcome-unknown")).toBe(true);
          }
        } else {
          expect(result.ok).toBe(true);
          if (result.ok) {
            receipt = result.value;
            expect(receipt.run(() => "admitted once")).toBe("admitted once");
          }
        }
      } finally {
        restoreSettlement?.();
        spy.mockRestore();
        receipt?.finish("interrupted");
        await receipt?.settled?.();
      }
    });
  },
);
