import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  listSessionPendingInputs,
  readSessionPendingInput,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  registerSessionPendingInputOwner,
  releaseSessionPendingInputOwner,
  type SessionPendingInputOwner,
} from "./session-accessor.sqlite-pending-inputs.js";
import { readPendingInputHistoryInDatabase } from "./session-pending-input-history.kernel.js";

it("serves empty pending history from its counted snapshot in one data read", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:empty-pending-history",
      sessionId: "empty-pending-history",
    };
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
    const counter = trackSqliteStatementExecutions(database.db, ["pending"], (query) =>
      /\bfrom\s+"?session_pending_inputs\b/i.test(query) ? "pending" : null,
    );
    try {
      expect(readPendingInputHistoryInDatabase(database, scope)).toEqual({ rows: [], total: 0 });
      expect(counter.counts.pending).toBe(1);
    } finally {
      counter.restore();
    }
  });
});

it("bounds materialized pending pages by bytes without truncating input or skipping its cursor", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:pending-history-bytes",
      sessionId: "pending-history-bytes",
    };
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
    const content = "x".repeat(Math.floor(MAX_PAYLOAD_BYTES / 2));
    const receipts: SessionPendingInputReceipt[] = [];
    try {
      for (const runId of ["large-first", "large-second"]) {
        receipts.push(
          expectDefined(
            await stageSessionPendingInput(scope, {
              runId,
              message: { role: "user", content, timestamp: 100, idempotencyKey: `${runId}:user` },
              assertCurrent: () => {},
            }),
            "Expected accepted input custody",
          ),
        );
      }
      const page = await listSessionPendingInputs(scope);
      expect(page.items.map((input) => input.id)).toEqual([receipts[1]?.inputId]);
      expect(page.items[0]?.message.content === content).toBe(true);
      expect(page.total).toBe(2);
      expect(page.nextBefore).toBeDefined();
      const older = await listSessionPendingInputs(scope, { before: page.nextBefore });
      expect(older.items.map((input) => input.id)).toEqual([receipts[0]?.inputId]);
      expect(older.items[0]?.message.content === content).toBe(true);
      expect(older.nextBefore).toBeUndefined();
    } finally {
      for (const receipt of receipts) {
        receipt.finish("interrupted");
      }
      await Promise.all(receipts.map(async (receipt) => receipt.settled?.()));
    }
  });
});

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
    await stale.settled?.();
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
      await receipt.settled?.();
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
      await receipt.settled?.();
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
      await second.settled?.();
      database.db
        .prepare("UPDATE session_pending_inputs SET state = 'queued' WHERE input_id = ?")
        .run(second.inputId);
      const { readOpenClawAgentDatabaseIdentity } =
        await import("../../state/openclaw-agent-db-identity.js");
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
        finish: () => releaseSessionPendingInputOwner(owner),
      };
      let registered = false;
      const spy = probe.admission(workerAdmission, (request, grant, callback) => {
        if (request.stage === phase && !registered) {
          registerSessionPendingInputOwner(owner);
          registered = true;
        }
        callback(request, grant);
      });
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
    await receipt.settled?.();
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
