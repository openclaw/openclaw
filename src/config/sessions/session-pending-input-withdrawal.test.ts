import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
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
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import { parseSessionPendingInputMessage } from "./session-pending-input-value.js";
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

async function withInputs(
  run: (inputs: ReturnType<typeof createInputs>) => Promise<void>,
  store: "default" | "shared" = "default",
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({
      agentId: target.agentId,
      ...(store === "shared" ? { path: state.statePath("shared-withdrawal.sqlite") } : {}),
    });
    const scope = { ...target, ...(store === "shared" ? { storePath: database.path } : {}) };
    const inputs = createInputs(database, scope);
    inputs.write();
    try {
      await run(inputs);
    } finally {
      inputs.receipts.forEach((receipt) => receipt.finish("cancelled"));
      await Promise.all(inputs.receipts.map(async (receipt) => receipt.settled?.()));
    }
  });
}

function createInputs(database: OpenClawAgentDatabase, scope: WithdrawalScope) {
  const receipts: SessionPendingInputReceipt[] = [];
  const rows = getSessionKysely(database.db).selectFrom("session_pending_inputs").selectAll();
  const write = (inputScope = scope, updatedAt = 1) =>
    writeSessionEntry(database, inputScope.sessionKey, {
      sessionId: inputScope.sessionId,
      updatedAt,
    });
  const stage = async (runId: string, inputScope = scope) => {
    const input = { runId, message: message(runId), requestFingerprint, assertCurrent };
    const receipt = expectDefined(
      await stageSessionPendingInput(inputScope, input),
      "Expected accepted input custody",
    );
    receipts.push(receipt);
    return receipt;
  };
  return {
    scope,
    receipts,
    stage,
    write,
    read: (inputId: string) =>
      expectDefined(
        executeSqliteQueryTakeFirstSync(database.db, rows.where("input_id", "=", inputId)),
        "Expected retained pending input",
      ),
    discard: (runId: string, current = assertCurrent) =>
      discardSessionPendingInput(scope, runId, current),
  };
}

type PendingRow = ReturnType<ReturnType<typeof createInputs>["read"]>;
function expectWithdrawn(original: PendingRow, withdrawn: PendingRow) {
  expect(withdrawn).toEqual({ ...original, state: "cancelled", message_json: expect.any(String) });
  expect(parseSessionPendingInputMessage(withdrawn.message_json)).toEqual({
    ...parseSessionPendingInputMessage(original.message_json),
    display: false,
  });
}

it.each(["default", "shared"] as const)(
  "withdraws only the exact unconsumed input through the %s database worker",
  async (store) => {
    await withInputs(async ({ scope, stage, read, discard, write }) => {
      const siblingScope = {
        ...scope,
        sessionKey: "agent:main:withdrawal-sibling",
        sessionId: "withdrawal-sibling-session",
      };
      write(siblingScope);

      const removed = await stage("removed");
      const retained = await stage("retained");
      const sibling = await stage("removed", siblingScope);
      const original = read(removed.inputId);
      const retainedRow = read(retained.inputId);
      const siblingRow = read(sibling.inputId);
      expect(original).toMatchObject({
        state: "queued",
        consumed_event_id: null,
        request_hash: `request:${requestFingerprint}`,
      });

      const hostSql = observeHostDataSql();
      try {
        expect(await discard("removed")).toBe(true);
        expect(hostSql.queries).toEqual([]);
      } finally {
        hostSql.restore();
      }

      expectWithdrawn(original, read(removed.inputId));
      expect(read(retained.inputId)).toEqual(retainedRow);
      expect(read(sibling.inputId)).toEqual(siblingRow);
    }, store);
  },
);

it.each(["consumed", "superseded"] as const)(
  "preserves %s input custody on withdrawal",
  async (state) => {
    await withInputs(async ({ receipts, stage, read, discard, write }) => {
      const runId = "reused-run";
      const first = await stage(runId);
      let original = read(first.inputId);
      let successor: PendingRow | undefined;
      if (state === "consumed") {
        const second = await stage("second");
        const collected = expectDefined(
          bindSessionPendingInputSources([first, second], message("collected")),
          "Expected collected input custody",
        );
        receipts.push(collected);
        await collected.run(() => appendTranscriptMessage(target, { message: collected.message }));
        original = read(first.inputId);
        expect(original.consumed_event_id).toBe(collected.inputId);
      } else {
        const successorScope = { ...target, sessionId: "successor-session" };
        write(successorScope, 2);
        const receipt = await stage(runId, successorScope);
        successor = read(receipt.inputId);
        expect(read(first.inputId)).toEqual(original);
      }
      expect(await discard(runId)).toBe(false);
      expect(read(first.inputId)).toEqual(original);
      if (successor) {
        expect(read(successor.input_id)).toEqual(successor);
      }
    });
  },
);

it("rolls back withdrawal when current authority is revoked at commit", async () => {
  await withInputs(async ({ stage, read, discard }) => {
    const receipt = await stage("revoked");
    const original = read(receipt.inputId);
    let current = true;
    const admitted = probe.admission(admission, (request, grant, callback) => {
      if (request.stage === "commit") {
        current = false;
      }
      return callback(request, grant);
    });
    try {
      await expect(
        discard("revoked", () => {
          if (!current) {
            throw new Error("Withdrawal authority revoked");
          }
        }),
      ).rejects.toThrow("Withdrawal authority revoked");
      expect(current).toBe(false);
      expect(read(receipt.inputId)).toEqual(original);
    } finally {
      admitted.mockRestore();
    }
  });
});

it("recovers the committed withdrawal when delivery of the worker result fails", async () => {
  await withInputs(async ({ stage, read, discard }) => {
    const receipt = await stage("lost-result");
    const before = read(receipt.inputId);
    const lostResult = new Error("Withdrawal committed but its result was lost");
    let verifiedCommits = 0;
    const original = workerStore.runSqliteWorkerStoreOperation;
    const observer = vi
      .spyOn(workerStore, "runSqliteWorkerStoreOperation")
      .mockImplementation((store, operation, context, current, admit) => {
        let withdrawing = false;
        let grant: admission.SqliteWorkerOperationAdmission | undefined;
        let retention: RetainedWorkerTransactionAdmission | undefined;
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
                expect(grant?.committed).toEqual({
                  facts: {
                    kind: "session-pending-input-withdrawal",
                    sessionKey: target.sessionKey,
                    sessionId: target.sessionId,
                    runId: "lost-result",
                    withdrawn: true,
                  },
                });
                expect(grant?.settlement).toMatchObject({ kind: "completed" });
                expect(await retention?.settled).toEqual({ kind: "completed" });
                expectWithdrawn(before, read(receipt.inputId));
                verifiedCommits++;
                throw lostResult;
              },
            }),
          context,
          current,
          admit &&
            ((retained) => {
              const owned = admit(retained);
              if (withdrawing) {
                grant = owned.admission;
                retention = retained;
              }
              return owned;
            }),
        );
      });
    try {
      await expect(discard("lost-result")).resolves.toBe(true);
      expect(verifiedCommits).toBe(1);
      expectWithdrawn(before, read(receipt.inputId));
    } finally {
      observer.mockRestore();
    }
  });
});
