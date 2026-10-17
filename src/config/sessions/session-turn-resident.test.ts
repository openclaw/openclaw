import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { withActor, type Fixture, type Mutation } from "./session-actor-worker.test-support.js";
import { readPendingInput } from "./session-pending-input-operations.kernel.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import type { SessionTurnPlan } from "./session-turn.types.js";

// mock-isolation: The fixture owns its database lifetime and transcript ordering.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Disk-budget maintenance is independent of turn preparation.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

function turn(f: Fixture, key = "next-input"): SessionTurnPlan {
  return {
    agentId: "main",
    sessionKey: f.scope.sessionKey,
    options: {
      expectedSessionId: f.scope.sessionId,
      resolveRuntimeTarget: true,
      sessionFile: f.scope.sessionKey,
      messages: [{ message: { role: "user", content: key, idempotencyKey: key } }],
    },
  };
}

function countReads(f: Fixture) {
  return trackSqliteStatementExecutions(f.database.db, ["read"], (sql) =>
    /^select\b/iu.test(sql) ? "read" : null,
  );
}

async function stage(f: Fixture, plan: SessionTurnPlan) {
  const before = f.read();
  const pending = {
    kind: "stage" as const,
    sessionKey: plan.sessionKey,
    sessionId: f.scope.sessionId,
    idempotencyKey: "next-input",
    inputId: "next-input",
    runId: "next-run",
    requestHash: "next-request",
    lifecycleGeneration: "next-generation",
    trackCompletion: true,
    messageJson: JSON.stringify(plan.options.messages[0]!.message),
  };
  const expected = readPendingInput(f.database, pending);
  if (expected.kind !== "stage") {
    throw new Error("Expected pending input stage");
  }
  const command: Mutation = {
    type: "session.actor.acceptInput",
    input: {
      target: f.target,
      commandId: "stage-input",
      phaseId: "input",
      expectedState: buildRestartRecoveryExpectedState(before.entry!),
      lifecycle: { restartRecoveryDeliveryRunId: "next-run" },
      pending: { ...pending, expected },
    },
  };
  await f.prepare(command);
  return { outcome: f.mutate(command), pending };
}

it("prepares committed entry, window, transcript and pending facts with only the identity read", async () => {
  await withActor(async (f) => {
    const plan = turn(f);
    const { outcome, pending } = await stage(f, plan);
    expect(outcome.kind).toBe("committed");
    plan.custody = {
      ...pending,
      agentId: "main",
      databaseAgentId: "main",
      databasePath: f.database.path,
      transcriptInputId: pending.inputId,
    };
    const reads = countReads(f);
    try {
      expect(f.prepareTurn(plan)).toMatchObject({
        runtimeTarget: { sessionKey: f.scope.sessionKey, selectedSessionId: f.scope.sessionId },
        expectedSessionState: { restartRecoveryDeliveryRunId: "next-run" },
        messages: [{ pending: true, existing: undefined }],
        version: { rawSeq: null },
      });
      expect(reads.counts.read).toBe(1);
      // Resident pending rows are facts, never permission to consume another input.
      expect(() => f.prepareTurn({ ...plan, custody: undefined })).toThrow(
        "Pending input cannot be appended outside its admitted turn",
      );
    } finally {
      reads.restore();
    }
  });
});

it("keeps the committed preimage when pending and lifecycle writes roll back", async () => {
  await withActor(async (f) => {
    const plan = turn(f);
    f.hooks.withCommit = () => {
      throw new Error("rollback staged input");
    };
    expect((await stage(f, plan)).outcome.kind).toBe("rolled-back");
    delete f.hooks.withCommit;
    const prepared = f.prepareTurn(plan);
    expect(prepared.messages).toEqual([{ pending: false, existing: undefined }]);
    expect(prepared.expectedSessionState?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(f.nativeEntry()?.restartRecoveryDeliveryRunId).toBeUndefined();
  });
});

it("sees native in-process entry and transcript writes before the next preparation", async () => {
  await withActor((f) => {
    f.read();
    f.writeEntry({ ...f.nativeEntry()!, restartRecoveryDeliveryRunId: "native-run" });
    runSqliteImmediateTransactionSync(f.database.db, () =>
      appendTranscriptEventsInTransaction(f.database, f.scope, [
        { type: "message", id: "native", message: { role: "user", content: "native write" } },
      ]),
    );
    const prepared = f.prepareTurn(turn(f));
    expect(prepared.expectedSessionState).toMatchObject({
      restartRecoveryDeliveryRunId: "native-run",
    });
    expect(prepared.version?.rawSeq).toBe(0);
  });
});

it.each(["reset", "move"] as const)("uses canonical selection after session %s", async (change) => {
  await withActor((f) => {
    f.read();
    if (change === "reset") {
      f.writeEntry({ sessionId: "successor", updatedAt: 2 });
      expect(f.prepareTurn(turn(f)).result).toMatchObject({
        rejectedReason: "session-rebound",
        sessionEntry: { sessionId: "successor" },
      });
    } else {
      const destination = "agent:main:moved";
      f.writeEntry({ ...f.nativeEntry()!, restartRecoveryDeliveryRunId: "moved-run" }, destination);
      expect(f.prepareTurn(turn(f))).toMatchObject({
        runtimeTarget: { sessionKey: destination, selectedSessionId: f.scope.sessionId },
        expectedSessionState: { restartRecoveryDeliveryRunId: "moved-run" },
      });
    }
  });
});

it.each(["eviction", "restart"] as const)(
  "falls back without rehydrating after owner %s",
  async (change) => {
    await withActor((f) => {
      f.read();
      if (change === "restart") {
        f.restartActor();
      } else {
        for (let index = 0; index < 128; index += 1) {
          f.read({ ...f.target, sessionKey: `agent:main:other-${index}` });
        }
      }
      const reads = countReads(f);
      try {
        expect(f.prepareTurn(turn(f))).toMatchObject({
          runtimeTarget: { sessionKey: f.scope.sessionKey, selectedSessionId: f.scope.sessionId },
          messages: [{ pending: false, existing: undefined }],
        });
        expect(reads.counts.read).toBeGreaterThan(1);
      } finally {
        reads.restore();
      }
    });
  },
);

it("uses the actor's committed transcript version on the next turn", async () => {
  await withActor(async (f) => {
    const before = f.read();
    const command: Mutation = {
      type: "session.actor.acceptInput",
      input: {
        target: f.target,
        commandId: "append-input",
        phaseId: "input",
        expectedState: buildRestartRecoveryExpectedState(before.entry!),
        lifecycle: { restartRecoveryDeliveryRunId: "append-run" },
        turn: turn(f, "committed-input"),
      },
    };
    await f.prepare(command);
    expect(f.mutate(command).kind).toBe("committed");
    const reads = countReads(f);
    try {
      expect(f.prepareTurn(turn(f))).toMatchObject({
        version: { rawSeq: 1 },
        expectedSessionState: { restartRecoveryDeliveryRunId: "append-run" },
      });
      expect(reads.counts.read).toBe(1);
    } finally {
      reads.restore();
    }
  });
});

it("returns canonical retry bytes beyond the actor's 512-event window", async () => {
  await withActor((f) => {
    const events = Array.from({ length: 514 }, (_, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index ? `message-${index - 1}` : null,
      message: { role: "user", content: `stored-${index}`, idempotencyKey: `input-${index}` },
    }));
    runSqliteImmediateTransactionSync(f.database.db, () =>
      appendTranscriptEventsInTransaction(f.database, f.scope, events, {
        scheduleProjectionReconcile: false,
      }),
    );
    f.read();
    for (const index of [0, 513]) {
      const plan = turn(f, `input-${index}`);
      const prepared = f.prepareTurn(plan);
      expect(prepared.messages?.[0]?.existing).toMatchObject({
        messageId: `message-${index}`,
        message: { content: `stored-${index}` },
      });
      expect(f.prepareTurn(plan).messages).toEqual(prepared.messages);
    }
  });
});
