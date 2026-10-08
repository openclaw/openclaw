import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  isSqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { readWithdrawnUserTurnInputId } from "../../sessions/user-turn-transcript-admission.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";

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
      expect(await recorder.completeProcessingAsync?.(outcome)).toEqual(outcome);
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
      const createAdmission = admission.createSqliteWorkerOperationAdmission;
      const spy = vi
        .spyOn(admission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((callback, attachment) =>
          createAdmission((request, grant) => {
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
          }, attachment),
        );
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
      const createAdmission = admission.createSqliteWorkerOperationAdmission;
      const spy = vi
        .spyOn(admission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((callback, attachment) =>
          createAdmission((request, grant) => {
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
          }, attachment),
        );
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
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    let rotated = false;
    const spy = vi
      .spyOn(admission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback, attachment) =>
        createAdmission((request, grant) => {
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
        }, attachment),
      );
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

it.each(["lost reply", "unknown settlement"] as const)(
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
