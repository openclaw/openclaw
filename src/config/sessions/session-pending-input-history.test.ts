import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  listSessionPendingInputs,
  readSessionPendingInput,
  stageSessionPendingInput,
} from "./session-accessor.pending-inputs.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  registerSessionPendingInputOwner,
  type SessionPendingInputOwner,
} from "./session-accessor.sqlite-pending-inputs.js";

it("reads pending history and exact messages without caller-thread data SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:pending-history",
      sessionId: "pending-history-session",
    };
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
    let aborted = false;
    const receipt = await stageSessionPendingInput(scope, {
      runId: "live",
      message: {
        role: "user",
        content: "Synthetic pending input",
        timestamp: 100,
        idempotencyKey: "live:user",
      },
      assertCurrent: () => {
        if (aborted) {
          throw new Error("Execution aborted; disposition still owned");
        }
      },
    });
    expect(receipt).toBeDefined();
    if (!receipt) {
      throw new Error("Expected accepted input");
    }
    const stale = await stageSessionPendingInput(scope, {
      runId: "stale",
      message: { ...receipt.message, idempotencyKey: "stale:user" },
      assertCurrent: () => {},
    });
    if (!stale) {
      throw new Error("Expected stale fixture");
    }
    stale.finish("interrupted");
    // A persisted pre-restart row has no process-local custody.
    database.db
      .prepare("UPDATE session_pending_inputs SET state = 'queued' WHERE input_id = ?")
      .run(stale.inputId);
    aborted = true;
    const hostSql = observeHostDataSql();
    try {
      expect(await listSessionPendingInputs(scope)).toMatchObject({
        total: 2,
        items: [
          { id: receipt.inputId, state: "queued" },
          { id: stale.inputId, state: "interrupted" },
        ],
      });
      expect(await readSessionPendingInput(scope, receipt.inputId)).toMatchObject({
        id: receipt.inputId,
        state: "queued",
      });
      expect(hostSql.queries).toEqual([]);
    } finally {
      hostSql.restore();
      receipt.finish("cancelled");
    }
    expect(await readSessionPendingInput(scope, receipt.inputId)).toMatchObject({
      state: "cancelled",
    });
  });
});

it.each(["transaction", "commit"] as const)(
  "rechecks live custody inside the %s grant",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:late-custody",
        sessionId: "late-custody",
      };
      const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
      writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
      const receipt = await stageSessionPendingInput(scope, {
        runId: "late",
        message: {
          role: "user",
          content: "Synthetic late custody",
          timestamp: 1,
          idempotencyKey: "late:user",
        },
        assertCurrent: () => {},
      });
      if (!receipt) {
        throw new Error("Expected custody fixture");
      }
      receipt.finish("interrupted");
      database.db
        .prepare("UPDATE session_pending_inputs SET state = 'queued' WHERE input_id = ?")
        .run(receipt.inputId);
      const second = await stageSessionPendingInput(scope, {
        runId: "second",
        message: { ...receipt.message, idempotencyKey: "second:user" },
        assertCurrent: () => {},
      });
      if (!second) {
        throw new Error("Expected sibling custody fixture");
      }
      second.finish("interrupted");
      database.db
        .prepare("UPDATE session_pending_inputs SET state = 'queued' WHERE input_id = ?")
        .run(second.inputId);
      const source = { agentId: scope.agentId, path: database.path };
      const { readOpenClawAgentDatabaseIdentity } =
        await import("../../state/openclaw-agent-db-identity.js");
      const { finishSessionPendingInputOwner } =
        await import("./session-accessor.sqlite-pending-inputs.js");
      const identity = readOpenClawAgentDatabaseIdentity(database);
      const owner: SessionPendingInputOwner = {
        inputId: receipt.inputId,
        transcriptInputId: receipt.inputId,
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
        databasePath: database.path,
        workerDatabasePath: identity.canonicalPath,
        idempotencyKey: "late:user",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        messageJson: JSON.stringify(receipt.message),
        assertCurrent: () => {
          throw new Error("Aborted execution still owns disposition");
        },
        finish: (disposition) =>
          finishSessionPendingInputOwner(
            owner,
            disposition,
            {
              ...source,
              databaseIdentity: identity.identity,
              databaseBirthtime: identity.birthtime,
            },
            source,
          ),
      };
      let registered = false;
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      const spy = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((callback, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === phase && !registered) {
              registerSessionPendingInputOwner(owner);
              registered = true;
            }
            callback(request, grant);
          }, attachment),
        );
      const hostSql = observeHostDataSql();
      try {
        const read = listSessionPendingInputs(scope);
        if (phase === "transaction") {
          await expect(read).resolves.toMatchObject({
            items: [
              { id: receipt.inputId, state: "queued" },
              { id: second.inputId, state: "interrupted" },
            ],
          });
        } else {
          await expect(read).rejects.toThrow("acquired live custody");
        }
        expect(registered).toBe(true);
        expect(hostSql.queries).toEqual([]);
      } finally {
        hostSql.restore();
        spy.mockRestore();
        const beforeFinish = database.db
          .prepare("SELECT state FROM session_pending_inputs ORDER BY seq")
          .all();
        owner.finish("cancelled");
        if (phase === "commit") {
          expect(beforeFinish).toEqual([{ state: "queued" }, { state: "queued" }]);
        }
      }
      expect(await readSessionPendingInput(scope, receipt.inputId)).toMatchObject({
        state: "cancelled",
      });
    });
  },
);

it("publishes an acknowledged interruption after the ordinary worker reply is lost", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:lost-history-reply",
      sessionId: "lost-history-reply",
    };
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
    const receipt = await stageSessionPendingInput(scope, {
      runId: "lost",
      message: {
        role: "user",
        content: "Synthetic lost reply",
        timestamp: 1,
        idempotencyKey: "lost:user",
      },
      assertCurrent: () => {},
    });
    if (!receipt) {
      throw new Error("Expected retained input");
    }
    receipt.finish("interrupted");
    database.db
      .prepare("UPDATE session_pending_inputs SET state = 'queued' WHERE input_id = ?")
      .run(receipt.inputId);
    const original = workerStore.runSqliteWorkerStoreOperation;
    let executions = 0;
    const spy = vi
      .spyOn(workerStore, "runSqliteWorkerStoreOperation")
      .mockImplementation(
        <Operations extends SqliteWorkerOperations, T>(
          store: SqliteWorkerStore<Operations>,
          operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
          stateContext?: Parameters<typeof original>[2],
          assertOperationCurrent?: Parameters<typeof original>[3],
          createAdmission?: Parameters<typeof original>[4],
        ) =>
          original(
            store,
            (worker) =>
              operation({
                execute: async (command, options) => {
                  const value = await worker.execute(command, options);
                  if (command.type === "session.pendingInputs.interruptHistory") {
                    executions++;
                    throw new Error("Synthetic result delivery failure");
                  }
                  return value;
                },
              }),
            stateContext,
            assertOperationCurrent,
            createAdmission,
          ),
      );
    try {
      expect(await readSessionPendingInput(scope, receipt.inputId)).toMatchObject({
        state: "interrupted",
      });
      expect(executions).toBe(1);
      expect(
        database.db
          .prepare("SELECT state FROM session_pending_inputs WHERE input_id = ?")
          .get(receipt.inputId),
      ).toEqual({ state: "interrupted" });
    } finally {
      spy.mockRestore();
    }
  });
});
