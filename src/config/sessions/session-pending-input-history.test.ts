import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core/expect";
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
import { MAX_PAYLOAD_BYTES } from "../../gateway/payload-limits.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  listSessionPendingInputs,
  readSessionPendingInput,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { createSessionActorFactory } from "./session-actor-durable.js";
import { readSessionPendingInputContext } from "./session-pending-input-history.js";
import { readPendingInputHistoryInDatabase } from "./session-pending-input-history.kernel.js";
import * as historyRuntime from "./session-transcript-worker-runtime.js";

it("skips covered empty history and reads a newly staged input after its owner commits", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:resident-pending-history",
      sessionId: "resident-pending-history",
      storePath: database.path,
      env,
    };
    writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
    const identity = readOpenClawAgentDatabaseIdentity(database);
    if (typeof identity.identity !== "string") {
      throw new Error("Pending history fixture requires a durable database");
    }
    const actor = await createSessionActorFactory({
      agentId: scope.agentId,
      path: database.path,
      env,
    }).acquire(
      {
        sessionKey: scope.sessionKey,
        database: {
          kind: "file",
          physicalIdentity: identity.identity,
          birthtime: identity.birthtime,
          nativeLocation: database.path,
        },
      },
      { assertCurrent() {}, assertReadable() {} },
    );
    const authority = { assertCurrent() {}, authorize() {} };
    let receipt: SessionPendingInputReceipt | undefined;
    const history = vi.spyOn(historyRuntime, "withSessionHistoryWorkerDatabase");
    try {
      await actor.read(authority);
      expect(await listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
      expect(history).not.toHaveBeenCalled();

      receipt = await stageSessionPendingInput(scope, {
        runId: "after-empty-read",
        message: {
          role: "user",
          content: "Retain this newly accepted input",
          timestamp: 1,
          idempotencyKey: "after-empty-read:user",
        },
        assertCurrent() {},
      });
      expect(receipt).toBeDefined();
      expect(await listSessionPendingInputs(scope)).toMatchObject({
        total: 1,
        items: [{ id: receipt?.inputId, state: "queued" }],
      });

      // A new empty current window cannot hide retained input from the old window.
      writeSessionEntry(database, scope.sessionKey, { sessionId: "next-window", updatedAt: 2 });
      await actor.read(authority);
      expect(await listSessionPendingInputs(scope)).toMatchObject({
        total: 1,
        items: [{ id: receipt?.inputId, state: "interrupted" }],
      });
    } finally {
      history.mockRestore();
      receipt?.finish("interrupted");
      await receipt?.settled?.();
      await actor.release();
    }
  });
});

it("reuses the admitted physical owner for repeated pending history reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:prepared-pending-history",
      sessionId: "prepared-pending-history",
    };
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
    await listSessionPendingInputs(scope);
    const stat = vi.spyOn(fs, "statSync");
    const realpath = vi.spyOn(fs.realpathSync, "native");
    try {
      expect(await listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
      expect(stat.mock.calls.filter(([pathname]) => pathname === database.path)).toHaveLength(0);
      expect(realpath.mock.calls.filter(([pathname]) => pathname === database.path)).toHaveLength(
        0,
      );
    } finally {
      stat.mockRestore();
      realpath.mockRestore();
    }
  });
});

it("serves empty pending history from its counted snapshot in one data read", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:empty-pending-history",
      sessionId: "empty-pending-history",
    };
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
    const counter = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["pending"],
      (query) => (/\bfrom\s+"?session_pending_inputs\b/i.test(query) ? "pending" : null),
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
      expect(await readSessionPendingInputContext(scope)).toEqual({
        items: page.items,
        nextBefore: page.nextBefore,
      });
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

it("reads count-free context in one statement and includes later committed inputs", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:pending-context",
      sessionId: "pending-context",
    };
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
    const read = () => {
      const counter = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(database.db),
        ["read"],
        () => "read",
      );
      try {
        const page = readPendingInputHistoryInDatabase(database, { ...scope, includeTotal: false });
        expect(counter.counts.read).toBe(1);
        expect(page.total).toBeUndefined();
        return page;
      } finally {
        counter.restore();
      }
    };
    expect(read().rows).toEqual([]);
    const receipt = expectDefined(
      await stageSessionPendingInput(scope, {
        runId: "later-input",
        message: {
          role: "user",
          content: "Retained after the empty read",
          timestamp: 1,
          idempotencyKey: "later-input:user",
        },
        assertCurrent() {},
      }),
      "Expected accepted input custody",
    );
    try {
      receipt.finish("interrupted");
      await receipt.settled?.();
      expect(read().rows).toMatchObject([{ input_id: receipt.inputId, state: "interrupted" }]);
      expect(await readSessionPendingInputContext(scope)).toMatchObject({
        items: [
          {
            id: receipt.inputId,
            state: "interrupted",
            message: { content: "Retained after the empty read" },
          },
        ],
      });
    } finally {
      receipt.finish("interrupted");
      await receipt.settled?.();
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

it("keeps a recovered owner queued when its generation changes after the history snapshot", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:history-recovery",
      sessionId: "history-recovery",
    };
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
    const input = {
      runId: "recover-during-history",
      requestFingerprint: "history-recovery",
      message: {
        role: "user" as const,
        content: "Keep the recovered input queued",
        timestamp: 1,
        idempotencyKey: "recover-during-history:user",
      },
      assertCurrent() {},
    };
    const original = expectDefined(
      await stageSessionPendingInput(scope, input),
      "Expected the original accepted input",
    );
    let recovered: SessionPendingInputReceipt | undefined;
    const readReady = createDeferred();
    const resume = createDeferred();
    const readHistory = historyRuntime.withSessionHistoryWorkerDatabase;
    let paused = false;
    const spy = vi
      .spyOn(historyRuntime, "withSessionHistoryWorkerDatabase")
      .mockImplementation(
        <T>(
          options: Parameters<typeof readHistory>[0],
          operation: (owner: historyRuntime.SessionHistoryWorkerDatabase) => Promise<T>,
          lane?: Parameters<typeof readHistory>[2],
        ) =>
          readHistory(
            options,
            (owner) =>
              operation({
                ...owner,
                readPendingInputHistory: async (...args) => {
                  const snapshot = await owner.readPendingInputHistory(...args);
                  if (!paused) {
                    paused = true;
                    readReady.resolve();
                    await resume.promise;
                  }
                  return snapshot;
                },
              }),
            lane,
          ),
      );
    const history = listSessionPendingInputs(scope);
    try {
      await withinTest(
        awaitGateBeforeSettlement(readReady.promise, history, "History skipped its reader"),
        signal,
      );
      original.finish("interrupted");
      await original.settled?.();
      rotateAgentEventLifecycleGeneration();
      recovered = expectDefined(
        await stageSessionPendingInput(scope, input),
        "Expected recovered input ownership",
      );
      expect(recovered.inputId).toBe(original.inputId);
      resume.resolve();
      await expect(history).resolves.toMatchObject({
        items: [{ id: original.inputId, state: "queued" }],
      });
      expect(await readSessionPendingInput(scope, original.inputId)).toMatchObject({
        state: "queued",
      });
    } finally {
      resume.resolve();
      await Promise.allSettled([history]);
      spy.mockRestore();
      original.finish("interrupted");
      recovered?.finish("interrupted");
      await Promise.all([original.settled?.(), recovered?.settled?.()]);
    }
  });
});

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
