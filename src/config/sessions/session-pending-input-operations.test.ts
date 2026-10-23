import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
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
import { isSqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
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
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import { mutatePendingInput, readPendingInput } from "./session-pending-input-operations.kernel.js";
import type { PendingInputMutation } from "./session-pending-input-operations.types.js";
import { interceptPendingInputWorker } from "./session-pending-input.test-support.js";

afterEach(() => resetConfigRuntimeState());

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
const sessionEntry = () => ({ sessionId: scope.sessionId, updatedAt: 1 });
const ok = () => buildAgentRunTerminalOutcome({ status: "ok" });

function interceptPublication(
  phase: "transaction" | "commit",
  intercept: (publication: Record<string, unknown>) => void,
) {
  return probe.admission(admission, (request, grant, callback) => {
    const facts = request.facts;
    if (request.stage === phase && isRecord(facts) && isRecord(facts.publication)) {
      intercept(facts.publication);
    }
    callback(request, grant);
  });
}

function makeRecorder(runId: string, storePath?: string, trackInputCompletion?: boolean) {
  return createUserTurnTranscriptRecorder({
    message: message(runId),
    target: { ...scope, storePath, sessionEntry: sessionEntry() },
    trackInputCompletion,
  });
}

async function stageRecorder(runId: string, storePath?: string, tracked?: boolean) {
  const recorder = makeRecorder(runId, storePath, tracked);
  expect(await recorder.stageApproved!({ runId, assertCurrent() {} })).toBe(true);
  return recorder;
}

it("uses legacy completion only when async completion is absent", async () => {
  setRuntimeConfigSnapshot({});
  const outcome = ok();
  const legacy = vi.fn(() => outcome);
  const recorder = {
    ...makeRecorder("legacy"),
    completeProcessingAsync: undefined,
    completeProcessing: legacy,
  };
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const plugin = new PluginInstance("pending-input-legacy-recorder");
  try {
    await plugin.run(async () => {
      expect(await completeUserTurnProcessing(recorder, outcome)).toEqual(outcome);
      expect(await completeUserTurnProcessing(recorder, outcome)).toEqual(outcome);
    });
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("completeProcessingAsync"),
      { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
    );
    expect(
      await completeUserTurnProcessing(
        { ...recorder, completeProcessingAsync: async () => undefined },
        outcome,
      ),
    ).toBeUndefined();
    await expect(
      completeUserTurnProcessing(
        {
          ...recorder,
          completeProcessingAsync: () => Promise.reject(new Error("Async completion failed")),
        },
        outcome,
      ),
    ).rejects.toThrow("Async completion failed");
    expect(legacy).toHaveBeenCalledTimes(2);
  } finally {
    warning.mockRestore();
    await plugin.dispose();
  }
});

function createFixture() {
  setRuntimeConfigSnapshot({});
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
  writeSessionEntry(database, scope.sessionKey, sessionEntry());
  const rows = (table: string, columns = "*") =>
    database.db.prepare(`SELECT ${columns} FROM ${table}`).all();
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
    pending: () => rows("session_pending_inputs ORDER BY seq", "run_id, state, request_hash"),
    completions: () => rows("session_input_completions"),
    rows,
  };
}

function withFixture(run: (fixture: ReturnType<typeof createFixture>) => Promise<void>) {
  return withOpenClawTestState({ scenario: "minimal" }, () => run(createFixture()));
}

it("supports synchronous recorder completion during compatibility", () =>
  withFixture(async ({ pending, rows }) => {
    const recorder = await stageRecorder("host-legacy", undefined, true);
    const outcome = ok();
    expect(recorder.completeProcessing!(outcome)).toEqual(outcome);
    expect(recorder.getProcessingCompletion!()).toEqual(outcome);
    expect(rows("session_input_completions", "outcome_json")).toEqual([
      { outcome_json: JSON.stringify(outcome) },
    ]);
    expect(pending()).toEqual([]);
    expect(await recorder.completeProcessingAsync?.(outcome)).toEqual(outcome);
    await recorder.waitForPendingInputSettlement!();
  }));

it("shares transaction rows, returns the staging postimage and rejects stale custody", () =>
  withFixture(async ({ database }) => {
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
    const buckets = [
      [/\bfrom "session_nodes"/iu, "entry"],
      [/\bfrom "session_members"/iu, "members"],
      [/\bfrom "session_pending_inputs"/iu, "pending"],
      [/\bfrom "session_input_completions"/iu, "completion"],
    ] as const;
    const counter = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["entry", "members", "pending", "completion"],
      (sql) => buckets.find(([pattern]) => pattern.test(sql))?.[1] ?? null,
    );
    let staged;
    try {
      staged = mutate(input);
      expect(counter.counts).toEqual({ entry: 1, members: 1, pending: 1, completion: 0 });
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

    expect(mutate(stage()).stagedInput).toEqual(staged.stagedInput);

    const completionCounter = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["completion"],
      (sql) => (/\bfrom "session_input_completions"/iu.test(sql) ? "completion" : null),
    );
    const outcome = ok();
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
  }));

it("stages and settles user turns without caller-thread SQL", () =>
  withFixture(async ({ database, stage, pending, rows }) => {
    const recorder = makeRecorder("completed", database.path, true);
    let cancelled: SessionPendingInputReceipt | undefined;
    const sql = observeHostDataSql();
    try {
      expect(await recorder.stageApproved?.({ runId: "completed", assertCurrent() {} })).toBe(true);
      expect(sql.queries).toEqual([]);
      cancelled = await stage("cancelled");
      const outcome = ok();
      expect(await completeUserTurnProcessing(recorder, outcome)).toEqual(outcome);
      expect(recorder.getProcessingCompletion?.()).toEqual(outcome);
      recorder.finishPendingInput?.("interrupted");
      cancelled.finish("cancelled");
      expect(() => cancelled?.run(() => {})).toThrow(SessionPendingInputCustodyError);
      await Promise.all([recorder.waitForPendingInputSettlement?.(), cancelled.settled?.()]);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      recorder.finishPendingInput?.("interrupted");
      cancelled?.finish("interrupted");
      await Promise.all([recorder.waitForPendingInputSettlement?.(), cancelled?.settled?.()]);
    }
    expect(pending()).toMatchObject([{ run_id: "cancelled", state: "cancelled" }]);
    expect(rows("session_input_completions", "run_id, succeeded")).toEqual([
      { run_id: "completed", succeeded: 1 },
    ]);
  }));

it.each(["cancelled", "consumed", "failed"] as const)(
  "reports a withdrawn input only after confirmed cancellation: %s",
  (result) =>
    withFixture(async ({ database, pending: readPending }) => {
      const recorder = await stageRecorder(result, database.path);
      const pending = expectDefined(
        (await listSessionPendingInputs(scope)).items[0],
        "Expected accepted input",
      );
      expect(readWithdrawnUserTurnInputId(recorder)).toBeUndefined();
      if (result === "consumed") {
        await recorder.persistApproved();
        expect(recorder.isPendingInputConsumed?.()).toBe(true);
      }
      const spy = interceptPublication("commit", ({ receipt }) => {
        if (result === "failed" && isRecord(receipt) && receipt.operation === "finish") {
          throw new Error("Synthetic cancellation commit refused");
        }
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
        expect(readPending()).toMatchObject(
          result === "consumed"
            ? []
            : [{ run_id: result, state: result === "failed" ? "queued" : "cancelled" }],
        );
      } finally {
        spy.mockRestore();
        recorder.finishPendingInput?.("interrupted");
        await Promise.allSettled([recorder.waitForPendingInputSettlement?.()]);
      }
    }),
);

it("retains cancellation custody while completion waits", ({ signal }) =>
  withFixture(async ({ stage }) => {
    const receipt = await stage("cancelling", () => {}, true);
    await listSessionPendingInputs(scope);
    const entered = createDeferred();
    const release = createDeferred();
    const spy = interceptPendingInputWorker((worker) => ({
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
    }));
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
  }));

it.each(["transaction", "commit"] as const)(
  "refuses staging custody when the run ends at %s",
  (phase) =>
    withFixture(async ({ stage, pending }) => {
      let current = true;
      let revoked = false;
      const spy = interceptPublication(phase, ({ kind }) => {
        if (kind === "pending-input-settlement-custody") {
          current = false;
          revoked = true;
        }
      });
      try {
        await expect(
          stage("ended", () => {
            if (!current) {
              throw new SessionPendingInputCustodyError("Synthetic run ended during admission");
            }
          }),
        ).rejects.toBeInstanceOf(SessionPendingInputCustodyError);
        expect(revoked).toBe(true);
        expect(pending()).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    }),
);

it("preserves custody errors for worker-side request-hash mismatches", () =>
  withFixture(async ({ database, stage, pending, completions }) => {
    const receipt = await stage("hash-bound", () => {}, true);
    const original = pending();
    const originalHash = original[0]?.request_hash;
    database.db
      .prepare("UPDATE session_pending_inputs SET request_hash = ? WHERE input_id = ?")
      .run("another-request", receipt.inputId);
    try {
      await expect(receipt.completeAsync?.(ok())).rejects.toBeInstanceOf(
        SessionPendingInputCustodyError,
      );
      expect(completions()).toEqual([]);
      expect(pending()).toEqual([{ ...original[0], request_hash: "another-request" }]);
    } finally {
      database.db
        .prepare("UPDATE session_pending_inputs SET request_hash = ? WHERE input_id = ?")
        .run(originalHash ?? null, receipt.inputId);
      receipt.finish("interrupted");
      await expect(receipt.settled?.()).rejects.toBeInstanceOf(SessionPendingInputCustodyError);
    }
  }));

it("refuses completion after a lifecycle change during the worker wait", () =>
  withFixture(async ({ stage, completions }) => {
    const receipt = await stage("stale-lifecycle", () => {}, true);
    let rotated = false;
    const spy = interceptPublication("transaction", ({ receipt: publicationReceipt }) => {
      if (isRecord(publicationReceipt) && publicationReceipt.operation === "complete") {
        rotateAgentEventLifecycleGeneration();
        rotated = true;
      }
    });
    try {
      await expect(receipt.completeAsync?.(ok())).rejects.toThrow();
      expect(rotated).toBe(true);
      expect(completions()).toEqual([]);
    } finally {
      spy.mockRestore();
      receipt.finish("interrupted");
      await expect(receipt.settled?.()).rejects.toThrow();
    }
  }));

it.each(["lost reply", "unknown settlement", "independent committed write"] as const)(
  "settles staging with %s without replaying its native write",
  (fault) =>
    withFixture(async ({ stage, pending }) => {
      let executions = 0;
      let restoreSettlement: (() => void) | undefined;
      const spy = interceptPendingInputWorker((worker, context) => {
        let staging = false;
        let nativeAdmission: admission.SqliteWorkerOperationAdmission | undefined;
        context.onAdmission = (value) => {
          if (staging) {
            nativeAdmission = value;
          }
        };
        return {
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
            expect(nativeAdmission).toMatchObject({
              committed: { facts: { kind: "pending-input-settlement", operation: "stage" } },
              settlement: { kind: "completed" },
            });
            if (fault === "independent committed write") {
              runOpenClawAgentWriteTransaction(
                (database) =>
                  writeSessionEntry(database, "agent:main:independent-input", {
                    sessionId: "independent-input",
                    updatedAt: 2,
                  }),
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
        };
      });
      let receipt: SessionPendingInputReceipt | undefined;
      try {
        const result = stage("lost-result");
        if (fault === "unknown settlement") {
          await expect(result).rejects.toSatisfy((error: unknown) =>
            isSqliteWorkerError(error, "outcome-unknown"),
          );
        } else {
          receipt = await result;
          expect(receipt.run(() => "admitted once")).toBe("admitted once");
        }
        expect(executions).toBe(1);
        expect(pending()).toMatchObject([{ run_id: "lost-result", state: "queued" }]);
      } finally {
        restoreSettlement?.();
        spy.mockRestore();
        receipt?.finish("interrupted");
        await receipt?.settled?.();
      }
    }),
);
