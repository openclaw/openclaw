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
import {
  captureSessionQueuedInputsForRestart,
  readSessionPendingInputContext,
  readSessionQueuedInputPage,
} from "./session-pending-input-history.js";
import { readPendingInputHistoryInDatabase } from "./session-pending-input-history.kernel.js";
import {
  createUserPendingInput,
  createPendingHistoryFixture,
} from "./session-pending-input.test-support.js";
import * as historyRuntime from "./session-transcript-worker-runtime.js";

function pauseFirstPendingHistorySnapshot() {
  const ready = createDeferred();
  const release = createDeferred();
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
                  ready.resolve();
                  await release.promise;
                }
                return snapshot;
              },
            }),
          lane,
        ),
    );
  return { ready, release, spy };
}

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

      receipt = await stageSessionPendingInput(
        scope,
        createUserPendingInput(
          "after-empty-read",
          "Retain this newly accepted input",
          "after-empty-read:user",
        ),
      );
      expect(receipt).toBeDefined();
      expect(await listSessionPendingInputs(scope)).toMatchObject({
        total: 1,
        items: [{ id: receipt?.inputId, state: "queued" }],
      });

      // A new empty current window cannot hide retained input from the old window.
      writeSessionEntry(database, scope.sessionKey, { sessionId: "next-window", updatedAt: 2 });
      await actor.read(authority);
      expect(await listSessionPendingInputs(scope)).toMatchObject({
        total: 0,
        items: [],
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
    const { scope, database } = createPendingHistoryFixture("prepared-pending-history");
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
    const { scope, database } = createPendingHistoryFixture("empty-pending-history");
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
    const { scope } = createPendingHistoryFixture("pending-history-bytes");
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

it.each(["context", "id"] as const)(
  "reads %s in one statement and includes later committed inputs",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { scope, database } = createPendingHistoryFixture("pending-context");
      let inputId = "not-yet-written";
      const read = () => {
        const native = requireNativeSqliteDatabase(database.db);
        const exec = vi.spyOn(native, "exec");
        const counter = trackSqliteStatementExecutions(native, ["read"], () => "read");
        try {
          const page = readPendingInputHistoryInDatabase(database, {
            ...scope,
            ...(mode === "context" ? { includeTotal: false as const } : { id: inputId }),
          });
          expect(counter.counts.read + exec.mock.calls.length).toBe(1);
          expect(page.total).toBeUndefined();
          return page;
        } finally {
          counter.restore();
          exec.mockRestore();
        }
      };
      expect(read().rows).toEqual([]);
      const receipt = expectDefined(
        await stageSessionPendingInput(
          scope,
          createUserPendingInput(
            "later-input",
            "Retained after the empty read",
            "later-input:user",
          ),
        ),
        "Expected accepted input custody",
      );
      try {
        inputId = receipt.inputId;
        receipt.finish("interrupted");
        await receipt.settled?.();
        expect(read().rows).toEqual([]);
        expect(await readSessionPendingInputContext(scope)).toEqual({ items: [] });
      } finally {
        receipt.finish("interrupted");
        await receipt.settled?.();
      }
    });
  },
);

it("reads pending history and exact messages without caller-thread data SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { scope, database } = createPendingHistoryFixture(
      "pending-history",
      "pending-history-session",
    );
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
        total: 1,
        items: [{ id: receipt.inputId, state: "queued" }],
      });
      expect(await readSessionPendingInput(scope, stale.inputId)).toBeUndefined();
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

it("resumes only the live FIFO inputs captured at graceful shutdown, leaving crash rows inert", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { scope, database } = createPendingHistoryFixture("graceful-input-queue");
    const crashed = expectDefined(
      await stageSessionPendingInput(
        scope,
        createUserPendingInput("old-crash", "Preserve this text", "old-crash:user"),
      ),
      "Expected accepted input",
    );
    crashed.finish("interrupted");
    await crashed.settled?.();
    // A crash leaves durable text without process-local custody.
    database.db
      .prepare("UPDATE session_pending_inputs SET state = 'queued' WHERE input_id = ?")
      .run(crashed.inputId);
    const receipts = [];
    for (const runId of ["first", "second"]) {
      receipts.push(
        expectDefined(
          await stageSessionPendingInput(
            scope,
            createUserPendingInput(runId, runId, `${runId}:user`),
          ),
          "Expected accepted input",
        ),
      );
    }
    const captured = await captureSessionQueuedInputsForRestart(scope);
    expect(captured.queuedInputIds).toEqual(receipts.map((receipt) => receipt.inputId));
    captured.preserve();
    for (const receipt of receipts) {
      receipt.finish("cancelled");
      await receipt.settled?.();
    }
    expect(await listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
    const page = await readSessionQueuedInputPage(scope, {
      queuedInputIds: captured.queuedInputIds,
    });
    expect(page.rows.toReversed().map((row) => ({ runId: row.run_id, state: row.state }))).toEqual([
      { runId: "first", state: "queued" },
      { runId: "second", state: "queued" },
    ]);
    expect(await readSessionQueuedInputPage(scope, { queuedInputIds: [] })).toEqual({
      rows: [],
      total: 0,
    });
  });
});

it("keeps concurrent history readers free of orphaned input without mutating it", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { scope, database } = createPendingHistoryFixture("concurrent-pending-history");
    const receipt = expectDefined(
      await stageSessionPendingInput(
        scope,
        createUserPendingInput("orphaned", "Saved update", "orphaned:user"),
      ),
      "Expected accepted input",
    );
    receipt.finish("interrupted");
    await receipt.settled?.();
    database.db
      .prepare("UPDATE session_pending_inputs SET state = 'queued' WHERE input_id = ?")
      .run(receipt.inputId);
    const { ready: snapshotReady, release, spy } = pauseFirstPendingHistorySnapshot();
    const first = listSessionPendingInputs(scope);
    try {
      await withinTest(
        awaitGateBeforeSettlement(snapshotReady.promise, first, "History skipped its reader"),
        signal,
      );
      expect(await listSessionPendingInputs(scope)).toMatchObject({
        items: [],
      });
      release.resolve();
      await expect(first).resolves.toMatchObject({
        items: [],
      });
    } finally {
      release.resolve();
      await Promise.allSettled([first]);
      spy.mockRestore();
    }
  });
});
