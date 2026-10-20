import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { withEngineStoreAdmission } from "../../infra/database-engine/admission-scope.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type {
  createSessionActorWorkerFixture,
  Mutation,
} from "./session-actor-worker.test-support.js";
import { readPendingInput } from "./session-pending-input-operations.kernel.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import type { SessionTurnPlan } from "./session-turn.types.js";

type Fixture = ReturnType<typeof createSessionActorWorkerFixture>;

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
  const database = f.database.db;
  if (isPostgresSqlConnection(database)) {
    const counts = { read: 0 };
    const query = database.query.bind(database);
    // Preserve driver-specific query arguments, including readBigInts.
    const spy = vi.spyOn(database, "query").mockImplementation(
      new Proxy(query, {
        apply(target, receiver, args) {
          if (/^\s*(?:select|with)\b/iu.test(args[0])) {
            counts.read += 1;
          }
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
    return { counts, restore: () => spy.mockRestore() };
  }
  return trackSqliteStatementExecutions(database, ["read"], (sql) =>
    /^\s*(?:select|with)\b/iu.test(sql) ? "read" : null,
  );
}

async function stage(f: Fixture, plan: SessionTurnPlan) {
  const before = withEngineStoreAdmission(() => f.read());
  const pending = {
    kind: "stage" as const,
    sessionKey: plan.sessionKey,
    sessionId: f.scope.sessionId,
    idempotencyKey: "next-input",
    inputId: `${f.scope.sessionId}:next-input`,
    runId: "next-run",
    requestHash: "next-request",
    lifecycleGeneration: "next-generation",
    trackCompletion: true,
    messageJson: JSON.stringify(plan.options.messages[0]!.message),
  };
  const expected = withEngineStoreAdmission(() => readPendingInput(f.database, pending));
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
  return { outcome: withEngineStoreAdmission(() => f.mutate(command)), pending };
}

export function runSessionTurnResidentTests(
  withActor: (run: (fixture: Fixture) => void | Promise<void>) => Promise<void>,
) {
  it("prepares a fresh input from complete committed actor facts without reads", async () => {
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
      withEngineStoreAdmission(() => {
        const reads = countReads(f);
        try {
          expect(f.prepareTurn(plan)).toMatchObject({
            runtimeTarget: { sessionKey: f.scope.sessionKey, selectedSessionId: f.scope.sessionId },
            expectedSessionState: { restartRecoveryDeliveryRunId: "next-run" },
            messages: [{ pending: true, existing: undefined }],
            version: { rawSeq: null },
          });
          expect(reads.counts.read).toBe(0);
          // Resident pending rows are facts, never permission to consume another input.
          expect(() => f.prepareTurn({ ...plan, custody: undefined })).toThrow(
            "Pending input cannot be appended outside its admitted turn",
          );
        } finally {
          reads.restore();
        }
      });
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
      withEngineStoreAdmission(() => {
        const prepared = f.prepareTurn(plan);
        expect(prepared.messages).toEqual([{ pending: false, existing: undefined }]);
        expect(prepared.expectedSessionState?.restartRecoveryDeliveryRunId).toBeUndefined();
        expect(f.nativeEntry()?.restartRecoveryDeliveryRunId).toBeUndefined();
      });
    });
  });

  it("sees native in-process entry and transcript writes before the next preparation", async () => {
    await withActor((f) =>
      withEngineStoreAdmission(() => {
        f.read();
        f.writeEntry({ ...f.nativeEntry()!, restartRecoveryDeliveryRunId: "native-run" });
        runSqliteImmediateTransactionSync(f.database.db, () =>
          appendTranscriptEventsInTransaction(f.database, f.scope, [
            {
              type: "message",
              id: "native",
              message: { role: "user", content: "native write", idempotencyKey: "next-input" },
            },
          ]),
        );
        const prepared = f.prepareTurn(turn(f));
        expect(prepared.expectedSessionState).toMatchObject({
          restartRecoveryDeliveryRunId: "native-run",
        });
        expect(prepared.version?.rawSeq).toBe(0);
        expect(prepared.messages?.[0]?.existing).toMatchObject({
          messageId: "native",
          message: { content: "native write" },
        });
      }),
    );
  });

  it.each(["reset", "move"] as const)(
    "uses canonical selection after session %s",
    async (change) => {
      await withActor((f) =>
        withEngineStoreAdmission(() => {
          f.read();
          if (change === "reset") {
            f.writeEntry({ sessionId: "successor", updatedAt: 2 });
            expect(f.prepareTurn(turn(f)).result).toMatchObject({
              rejectedReason: "session-rebound",
              sessionEntry: { sessionId: "successor" },
            });
          } else {
            const destination = "agent:main:moved";
            f.writeEntry(
              { ...f.nativeEntry()!, restartRecoveryDeliveryRunId: "moved-run" },
              destination,
            );
            expect(f.prepareTurn(turn(f))).toMatchObject({
              runtimeTarget: { sessionKey: destination, selectedSessionId: f.scope.sessionId },
              expectedSessionState: { restartRecoveryDeliveryRunId: "moved-run" },
            });
          }
        }),
      );
    },
  );

  it.each(["eviction", "restart"] as const)(
    "falls back without rehydrating after owner %s",
    async (change) => {
      await withActor((f) =>
        withEngineStoreAdmission(() => {
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
              runtimeTarget: {
                sessionKey: f.scope.sessionKey,
                selectedSessionId: f.scope.sessionId,
              },
              messages: [{ pending: false, existing: undefined }],
            });
            expect(reads.counts.read).toBeGreaterThan(1);
          } finally {
            reads.restore();
          }
        }),
      );
    },
  );

  it("uses committed identities for fresh inputs and returns stored bytes on retry", async () => {
    await withActor(async (f) => {
      const before = withEngineStoreAdmission(() => f.read());
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
      expect(withEngineStoreAdmission(() => f.mutate(command)).kind).toBe("committed");
      withEngineStoreAdmission(() => {
        const reads = countReads(f);
        try {
          expect(f.prepareTurn(turn(f))).toMatchObject({
            version: { rawSeq: 1 },
            expectedSessionState: { restartRecoveryDeliveryRunId: "append-run" },
          });
          expect(reads.counts.read).toBe(0);
          const retry = turn(f, "committed-input");
          retry.options.messages[0]!.message = {
            role: "user",
            content: "different retry bytes",
            idempotencyKey: "committed-input",
          };
          expect(f.prepareTurn(retry).messages?.[0]?.existing).toMatchObject({
            message: { content: "committed-input" },
          });
        } finally {
          reads.restore();
        }
      });
    });
  });

  it("returns canonical retry bytes beyond the actor's 512-event window", async () => {
    await withActor((f) =>
      withEngineStoreAdmission(() => {
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
        const reads = countReads(f);
        try {
          expect(f.prepareTurn(turn(f)).messages?.[0]?.existing).toBeUndefined();
          expect(reads.counts.read).toBe(1);
        } finally {
          reads.restore();
        }
      }),
    );
  });

  it("scans assistant bodies without an indexed event identity", async () => {
    await withActor((f) =>
      withEngineStoreAdmission(() => {
        runSqliteImmediateTransactionSync(f.database.db, () =>
          appendTranscriptEventsInTransaction(f.database, f.scope, [
            {
              type: "message",
              message: { role: "assistant", content: "stored answer", idempotencyKey: "answer" },
            },
          ]),
        );
        f.read();
        const plan = turn(f, "answer");
        plan.options.messages[0]!.idempotencyLookup = "scan-assistant";
        expect(f.prepareTurn(plan).messages?.[0]?.existing).toMatchObject({
          messageId: "answer",
          message: { content: "stored answer" },
        });
      }),
    );
  });
}
