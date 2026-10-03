import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  bindSessionPendingInputSources,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { parseSessionPendingInputMessage } from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import { discardSessionPendingInput } from "./session-pending-input-withdrawal.js";

type WithdrawalScope = Parameters<typeof discardSessionPendingInput>[0];

const target = {
  agentId: "main",
  sessionKey: "agent:main:pending-input-withdrawal",
  sessionId: "withdrawal-session",
};
const assertCurrent = () => {};
const requestFingerprint = "f".repeat(64);
const message = (runId: string): PersistedUserTurnMessage => ({
  role: "user",
  content: `Synthetic queued prompt ${runId}`,
  timestamp: 100,
  idempotencyKey: `${runId}:user`,
  __openclaw: { transport: { clients: [{ id: "openclaw-control-ui", mode: "webchat" }] } },
});

async function stage(
  scope: WithdrawalScope,
  runId: string,
  receipts: SessionPendingInputReceipt[],
) {
  const receipt = expectDefined(
    await stageSessionPendingInput(scope, {
      runId,
      message: message(runId),
      requestFingerprint,
      assertCurrent,
    }),
    "Expected accepted input custody",
  );
  receipts.push(receipt);
  return receipt;
}

function readPendingRow(database: OpenClawAgentDatabase, inputId: string) {
  return expectDefined(
    executeSqliteQueryTakeFirstSync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_pending_inputs")
        .selectAll()
        .where("input_id", "=", inputId),
    ),
    "Expected retained pending input",
  );
}

it.each(["default", "shared"] as const)(
  "withdraws only the exact unconsumed input through the %s database worker",
  async (store) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawAgentDatabase({
        agentId: target.agentId,
        ...(store === "shared" ? { path: state.statePath("shared-withdrawal.sqlite") } : {}),
      });
      const scope = {
        ...target,
        ...(store === "shared" ? { storePath: database.path } : {}),
      };
      const siblingScope = {
        ...scope,
        sessionKey: "agent:main:withdrawal-sibling",
        sessionId: "withdrawal-sibling-session",
      };
      writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
      writeSessionEntry(database, siblingScope.sessionKey, {
        sessionId: siblingScope.sessionId,
        updatedAt: 1,
      });
      const receipts: SessionPendingInputReceipt[] = [];
      try {
        const removed = await stage(scope, "removed", receipts);
        const retained = await stage(scope, "retained", receipts);
        const sibling = await stage(siblingScope, "removed", receipts);
        const original = readPendingRow(database, removed.inputId);
        const retainedRow = readPendingRow(database, retained.inputId);
        const siblingRow = readPendingRow(database, sibling.inputId);
        expect(original).toMatchObject({
          state: "queued",
          consumed_event_id: null,
          request_hash: `request:${requestFingerprint}`,
        });

        const hostSql = observeHostDataSql();
        try {
          expect(await discardSessionPendingInput(scope, "removed", assertCurrent)).toBe(true);
          expect(hostSql.queries).toEqual([]);
        } finally {
          hostSql.restore();
        }

        const withdrawn = readPendingRow(database, removed.inputId);
        expect(withdrawn).toEqual({
          ...original,
          state: "cancelled",
          message_json: expect.any(String),
        });
        expect(parseSessionPendingInputMessage(withdrawn.message_json)).toEqual({
          ...parseSessionPendingInputMessage(original.message_json),
          display: false,
        });
        expect(readPendingRow(database, retained.inputId)).toEqual(retainedRow);
        expect(readPendingRow(database, sibling.inputId)).toEqual(siblingRow);
      } finally {
        for (const receipt of receipts) {
          receipt.finish("cancelled");
        }
        await Promise.all(receipts.map(async (receipt) => receipt.settled?.()));
      }
    });
  },
);

it("preserves a consumed source receipt when withdrawal targets its original run", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: target.agentId });
    writeSessionEntry(database, target.sessionKey, { sessionId: target.sessionId, updatedAt: 1 });
    const receipts: SessionPendingInputReceipt[] = [];
    try {
      const first = await stage(target, "first", receipts);
      const second = await stage(target, "second", receipts);
      const collected = expectDefined(
        bindSessionPendingInputSources([first, second], message("collected")),
        "Expected collected input custody",
      );
      receipts.push(collected);
      await collected.run(() => appendTranscriptMessage(target, { message: collected.message }));
      const original = readPendingRow(database, first.inputId);
      expect(original.consumed_event_id).toBe(collected.inputId);

      expect(await discardSessionPendingInput(target, "first", assertCurrent)).toBe(false);

      expect(readPendingRow(database, first.inputId)).toEqual(original);
    } finally {
      for (const receipt of receipts) {
        receipt.finish("cancelled");
      }
      await Promise.all(receipts.map(async (receipt) => receipt.settled?.()));
    }
  });
});

it("does not withdraw an old or successor input after the canonical session resets", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: target.agentId });
    writeSessionEntry(database, target.sessionKey, { sessionId: target.sessionId, updatedAt: 1 });
    const receipts: SessionPendingInputReceipt[] = [];
    try {
      const previous = await stage(target, "reused-run", receipts);
      const original = readPendingRow(database, previous.inputId);
      const successorScope = { ...target, sessionId: "successor-session" };
      writeSessionEntry(database, target.sessionKey, {
        sessionId: successorScope.sessionId,
        updatedAt: 2,
      });
      const successor = await stage(successorScope, "reused-run", receipts);
      const successorRow = readPendingRow(database, successor.inputId);
      expect(readPendingRow(database, previous.inputId)).toEqual(original);

      expect(await discardSessionPendingInput(target, "reused-run", assertCurrent)).toBe(false);

      expect(readPendingRow(database, previous.inputId)).toEqual(original);
      expect(readPendingRow(database, successor.inputId)).toEqual(successorRow);
    } finally {
      for (const receipt of receipts) {
        receipt.finish("cancelled");
      }
      await Promise.all(receipts.map(async (receipt) => receipt.settled?.()));
    }
  });
});

it("rolls back withdrawal when current authority is revoked at commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: target.agentId });
    writeSessionEntry(database, target.sessionKey, { sessionId: target.sessionId, updatedAt: 1 });
    const receipts: SessionPendingInputReceipt[] = [];
    const receipt = await stage(target, "revoked", receipts);
    const original = readPendingRow(database, receipt.inputId);
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    let current = true;
    const admitted = vi
      .spyOn(admission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            current = false;
          }
          return callback(request, grant);
        }, attachment),
      );
    try {
      await expect(
        discardSessionPendingInput(target, "revoked", () => {
          if (!current) {
            throw new Error("Withdrawal authority revoked");
          }
        }),
      ).rejects.toThrow("Withdrawal authority revoked");
      expect(current).toBe(false);
      expect(readPendingRow(database, receipt.inputId)).toEqual(original);
    } finally {
      admitted.mockRestore();
      receipt.finish("cancelled");
      await receipt.settled?.();
    }
  });
});

it("recovers the committed withdrawal when delivery of the worker result fails", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: target.agentId });
    writeSessionEntry(database, target.sessionKey, { sessionId: target.sessionId, updatedAt: 1 });
    const receipts: SessionPendingInputReceipt[] = [];
    const receipt = await stage(target, "lost-result", receipts);
    const before = readPendingRow(database, receipt.inputId);
    const deliveryFailure = new Error("Withdrawal committed but its result was lost");
    let verifiedCommits = 0;
    const original = workerStore.runSqliteWorkerStoreOperation;
    const observer = vi
      .spyOn(workerStore, "runSqliteWorkerStoreOperation")
      .mockImplementation(
        <Operations extends SqliteWorkerOperations, T>(
          store: SqliteWorkerStore<Operations>,
          operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
          stateContext?: Parameters<typeof original>[2],
          assertOperationCurrent?: Parameters<typeof original>[3],
          createAdmission?: Parameters<typeof original>[4],
        ) => {
          let withdrawing = false;
          let nativeAdmission: admission.SqliteWorkerOperationAdmission | undefined;
          let nativeRetention: RetainedWorkerTransactionAdmission | undefined;
          return original(
            store,
            (worker) =>
              operation({
                execute: async (command, options) => {
                  withdrawing = command.type === "session.pendingInputs.withdraw";
                  const result = await worker.execute(command, options);
                  if (!withdrawing) {
                    return result;
                  }
                  expect(nativeAdmission?.committed).toEqual({
                    facts: {
                      kind: "session-pending-input-withdrawal",
                      sessionKey: target.sessionKey,
                      sessionId: target.sessionId,
                      runId: "lost-result",
                      withdrawn: true,
                    },
                  });
                  expect(nativeAdmission?.settlement).toMatchObject({ kind: "completed" });
                  expect(await nativeRetention?.settled).toEqual({ kind: "completed" });
                  const withdrawn = readPendingRow(database, receipt.inputId);
                  expect(withdrawn.state).toBe("cancelled");
                  expect(parseSessionPendingInputMessage(withdrawn.message_json).display).toBe(
                    false,
                  );
                  verifiedCommits++;
                  throw deliveryFailure;
                },
              }),
            stateContext,
            assertOperationCurrent,
            createAdmission &&
              ((retained) => {
                const owned = createAdmission(retained);
                if (withdrawing) {
                  nativeAdmission = owned.admission;
                  nativeRetention = retained;
                }
                return owned;
              }),
          );
        },
      );
    try {
      await expect(discardSessionPendingInput(target, "lost-result", assertCurrent)).resolves.toBe(
        true,
      );
      expect(verifiedCommits).toBe(1);
      const withdrawn = readPendingRow(database, receipt.inputId);
      expect(withdrawn).toEqual({
        ...before,
        state: "cancelled",
        message_json: expect.any(String),
      });
      expect(parseSessionPendingInputMessage(withdrawn.message_json)).toEqual({
        ...parseSessionPendingInputMessage(before.message_json),
        display: false,
      });
    } finally {
      observer.mockRestore();
      receipt.finish("cancelled");
      await receipt.settled?.();
    }
  });
});
