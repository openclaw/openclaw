import { existsSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { lookupSessionGoalOperation } from "./goals-operations-read.js";
import { mutateSessionGoal, SessionGoalOperationError } from "./goals-operations.js";
import type {
  SessionGoalOperation,
  SessionTranscriptTurnMutation,
} from "./goals-operations.types.js";
import { createSessionGoal, clearSessionGoal, updateSessionGoalStatus } from "./goals.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { hasPendingCanonicalSessionValidation } from "./session-canonical-validation.js";
import { useTempSessionsFixture } from "./test-helpers.js";

// These tests exercise the durable owner, including rollback and process reopen; existing
// textual Goal tests protect the shared policy but cannot catch a split Goal/turn commit.
describe("typed Goal operation persistence", () => {
  const fixture = useTempSessionsFixture("openclaw-goal-operations-");
  const sessionKey = "agent:main:goal-operations";
  const sessionId = "goal-session-1";
  const now = Date.now();
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const identity = (operationId: string) => ({
    operationId,
    issuedAtMs: now,
    requestFingerprint: operationId,
  });
  const startOperation = (): SessionGoalOperation & { action: "start" } => ({
    ...identity("start-1"),
    action: "start",
    objective: "  clear the backlog 🦞\n/with literal café text\n\t",
  });
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
  const writeFixture = (write: (db: ReturnType<typeof database>["db"]) => void) =>
    runExclusiveSqliteSessionWrite(
      resolveSqliteScope(scope()),
      async () => write(database().db),
      "session.goal.mutate",
    );
  const fillReceipts = () =>
    writeFixture((db) => {
      db.prepare(
        `WITH RECURSIVE receipts(i) AS (
          VALUES (0) UNION ALL SELECT i + 1 FROM receipts WHERE i < 4095
        ) INSERT INTO session_goal_operations
          SELECT ?, 'retained-' || i, ?, 'fingerprint', '{}', ? FROM receipts`,
      ).run(sessionKey, sessionId, Number.MAX_SAFE_INTEGER);
    });
  const admit = (operation = startOperation(), extra: { shouldAppend?: () => boolean } = {}) =>
    persistSessionTranscriptTurn(scope(), {
      expectedSessionId: sessionId,
      runId: "run-1",
      messages: [
        {
          message: {
            role: "user",
            content: operation.objective,
            idempotencyKey: operation.operationId,
          },
          ...extra,
        },
      ],
      sessionTurnMutation: { kind: "goal", operation, runId: "run-1" },
      sessionLifecyclePatch: { status: undefined, lastRunId: "run-1" },
      updateMode: "none",
    });

  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), {
      sessionId,
      updatedAt: now,
      status: "done",
      totalTokens: 100,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
  });

  it("leaves missing stores and optional tables absent, then observes a newly committed receipt", async () => {
    const lookup = { ...scope(), expectedSessionId: sessionId, operation: startOperation() };
    const missing = path.join(path.dirname(database().path), "missing", "agent.sqlite");
    await expect(
      lookupSessionGoalOperation({ ...lookup, storePath: missing }),
    ).resolves.toBeUndefined();
    expect(existsSync(missing)).toBe(false);
    await writeFixture((db) => {
      db.exec("DROP TABLE session_goal_operations");
    });
    await expect(lookupSessionGoalOperation(lookup)).resolves.toBeUndefined();
    expect(
      database()
        .db.prepare("SELECT name FROM sqlite_schema WHERE name = 'session_goal_operations'")
        .get(),
    ).toBeUndefined();
    const first = await admit();
    await expect(lookupSessionGoalOperation(lookup)).resolves.toEqual(
      first.sessionTurnMutationResult?.result,
    );
    await expect(
      lookupSessionGoalOperation({
        ...lookup,
        operation: { ...startOperation(), issuedAtMs: now - 24 * 60 * 60 * 1000 },
      }),
    ).rejects.toMatchObject({ code: "expired" });
  });

  it("commits the literal objective, exact intent identity, lifecycle and receipt together", async () => {
    const skillsSnapshot = { prompt: "p".repeat(64 * 1024), skills: [] };
    await upsertSessionEntryCore(scope(), { ...loadSessionEntry(scope())!, skillsSnapshot });
    const identityMutation = vi.fn();
    const unsubscribe = onSessionIdentityMutation(identityMutation);
    onTestFinished(unsubscribe);
    const reads = trackSqliteStatementExecutions(database().db, ["sessionNodeSelects"], (sql) =>
      /^select\b/i.test(sql) && /\bfrom\s+"session_nodes"/i.test(sql) ? "sessionNodeSelects" : null,
    );
    let turn: Awaited<ReturnType<typeof admit>>;
    try {
      turn = await admit();
      // Target selection and the compound transaction both execute in workers.
      expect.soft(reads.counts.sessionNodeSelects).toBe(0);
      expect.soft(reads.rowCounts.sessionNodeSelects).toBe(0);
      expect.soft(reads.textBytes.sessionNodeSelects).toBe(0);
      expect(identityMutation).not.toHaveBeenCalled();
    } finally {
      reads.restore();
    }
    expect(turn.sessionEntry?.skillsSnapshot).toEqual(skillsSnapshot);
    const receipt = turn.sessionTurnMutationResult?.result;
    expect(receipt).toMatchObject({
      status: "started",
      runId: "run-1",
      action: "start",
      goal: { objective: startOperation().objective, tokenStart: 100 },
    });
    expect(loadSessionEntry(scope())?.status).toBeUndefined();
    expect(loadSessionEntry(scope())).toMatchObject({
      lastRunId: "run-1",
      goal: receipt?.goal,
      skillsSnapshot,
    });
    expect(turn.messages[0]?.message).toMatchObject({
      content: startOperation().objective,
      __openclaw: {
        intent: {
          kind: "session-goal-start",
          version: 1,
          goalId: receipt?.goalId,
          operationId: "start-1",
        },
      },
    });
    expect(
      await lookupSessionGoalOperation({
        ...scope(),
        expectedSessionId: sessionId,
        operation: startOperation(),
      }),
    ).toEqual(receipt);
    const editedObjective = "\t resume the café migration 🦞\n/keep every byte ";
    const editOperation = {
      ...identity("edit-literal"),
      action: "edit",
      goalId: receipt!.goalId,
      objective: editedObjective,
    } satisfies SessionGoalOperation;
    const editReads = trackSqliteStatementExecutions(
      database().db,
      ["sessionNodeSelects", "receiptStatements"],
      (sql) =>
        /^select\b/i.test(sql) && /\bfrom\s+"session_nodes"/i.test(sql)
          ? "sessionNodeSelects"
          : /\b(?:from|into)\s+"session_goal_operations"/i.test(sql)
            ? "receiptStatements"
            : null,
    );
    let edited: Awaited<ReturnType<typeof mutateSessionGoal>>;
    try {
      edited = await mutateSessionGoal({
        ...scope(),
        expectedSessionId: sessionId,
        operation: editOperation,
      });
      expect.soft(editReads.counts.sessionNodeSelects).toBe(0);
      expect.soft(editReads.rowCounts.sessionNodeSelects).toBe(0);
      expect.soft(editReads.counts.receiptStatements).toBe(0);
      expect.soft(editReads.textBytes.sessionNodeSelects).toBe(0);
    } finally {
      editReads.restore();
    }
    expect(identityMutation).not.toHaveBeenCalled();
    expect(hasPendingCanonicalSessionValidation(database())).toBe(false);
    expect(edited.sessionEntry).toMatchObject({ sessionId, lastRunId: "run-1" });
    expect(edited.sessionEntry?.status).toBeUndefined();
    expect(edited.result.goal?.objective).toBe(editedObjective);
    expect(edited.sessionEntry?.skillsSnapshot).toEqual(skillsSnapshot);
    expect(loadSessionEntry(scope())?.goal?.objective).toBe(editedObjective);
    expect(
      await lookupSessionGoalOperation({
        ...scope(),
        expectedSessionId: sessionId,
        operation: editOperation,
      }),
    ).toEqual(edited.result);
  });

  it("edits only the exact case-sensitive session without publishing an identity change", async () => {
    const target = { ...scope(), sessionKey: "agent:main:matrix:group:!Room:example.org" };
    const sibling = { ...scope(), sessionKey: "agent:main:matrix:group:!room:example.org" };
    await replaceSessionEntry(target, { sessionId, updatedAt: now });
    await replaceSessionEntry(sibling, { sessionId: "sibling-session", updatedAt: now });
    const goal = await createSessionGoal({ ...target, objective: "target objective" });
    await createSessionGoal({ ...sibling, objective: "sibling objective" });
    const beforeSibling = loadSessionEntry(sibling);
    const identityMutation = vi.fn();
    const unsubscribe = onSessionIdentityMutation(identityMutation);
    try {
      const edited = await mutateSessionGoal({
        ...target,
        expectedSessionId: sessionId,
        operation: {
          ...identity("edit-case-sensitive"),
          action: "edit",
          goalId: goal.id,
          objective: "updated target",
        },
      });
      expect(edited.result.goal?.objective).toBe("updated target");
      expect(loadSessionEntry(target)?.goal?.objective).toBe("updated target");
      expect(loadSessionEntry(sibling)).toEqual(beforeSibling);
      expect(identityMutation).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("rejects a session replacement made by the commit authority check", async () => {
    const goal = await createSessionGoal({ ...scope(), objective: "original objective" });
    const before = loadSessionEntry(scope());
    await expect(
      mutateSessionGoal({
        ...scope(),
        expectedSessionId: sessionId,
        operation: {
          ...identity("edit-rebound"),
          action: "edit",
          goalId: goal.id,
          objective: "must not commit",
        },
        assertCurrent: () => {
          replaceSessionEntrySync(scope(), {
            ...before!,
            sessionId: "replacement-session",
          });
        },
      }),
    ).rejects.toMatchObject({ code: "session-rebound" });
    expect(loadSessionEntry(scope())).toEqual(before);
  });

  it("replays the original success after clear and reopening without recreating Goal or turn", async () => {
    const first = await admit();
    await clearSessionGoal(scope());
    const eventsBefore = await loadTranscriptEvents(scope());
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const lookup = { ...scope(), expectedSessionId: sessionId, operation: startOperation() };
    await expect(lookupSessionGoalOperation(lookup)).resolves.toEqual(
      first.sessionTurnMutationResult?.result,
    );
    const conflict = lookupSessionGoalOperation({
      ...lookup,
      operation: { ...startOperation(), requestFingerprint: "different-attachment" },
    });
    await expect(conflict).rejects.toBeInstanceOf(SessionGoalOperationError);
    await expect(conflict).rejects.toMatchObject({ code: "operation-conflict" });
    const replay = await admit();
    expect(replay.sessionTurnMutationResult).toEqual({
      result: first.sessionTurnMutationResult?.result,
      replayed: true,
    });
    expect(replay.appendedCount).toBe(0);
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expect(await loadTranscriptEvents(scope())).toEqual(eventsBefore);
    await expect(admit({ ...startOperation(), objective: "different" })).rejects.toMatchObject({
      code: "operation-conflict",
    });
    await expect(
      admit({ ...startOperation(), requestFingerprint: "different-attachment" }),
    ).rejects.toMatchObject({ code: "operation-conflict" });
  });

  it("replays by SID even when the old writer revision no longer owns the session", async () => {
    const first = await admit();
    const events = await loadTranscriptEvents(scope());
    await upsertSessionEntryCore(scope(), {
      ...loadSessionEntry(scope())!,
      lifecycleRevision: "successor",
    });
    const replay = await persistSessionTranscriptTurn(scope(), {
      expectedSessionId: sessionId,
      expectedLifecycleRevision: "previous-writer",
      sessionTurnMutation: { kind: "goal", operation: startOperation(), runId: "run-1" },
      messages: [{ message: { role: "user", content: "must not append" } }],
      updateMode: "none",
    });
    expect(replay).toMatchObject({
      appendedCount: 0,
      sessionTurnMutationResult: {
        replayed: true,
        result: first.sessionTurnMutationResult?.result,
      },
    });
    expect(await loadTranscriptEvents(scope())).toEqual(events);
    expect(loadSessionEntry(scope())?.lifecycleRevision).toBe("successor");
  });

  it.each(["not json", JSON.stringify({ status: "started" })])(
    "rejects a corrupt receipt without reapplying the operation (%s)",
    async (corrupt) => {
      await admit();
      await clearSessionGoal(scope());
      await writeFixture((db) => {
        db.prepare("UPDATE session_goal_operations SET result_json = ? WHERE operation_id = ?").run(
          corrupt,
          "start-1",
        );
      });
      const eventsBefore = await loadTranscriptEvents(scope());
      await expect(
        lookupSessionGoalOperation({
          ...scope(),
          expectedSessionId: sessionId,
          operation: startOperation(),
        }),
      ).rejects.toMatchObject({ code: "receipt-invalid" });
      await expect(admit()).rejects.toMatchObject({ code: "receipt-invalid" });
      expect(loadSessionEntry(scope())?.goal).toBeUndefined();
      expect(await loadTranscriptEvents(scope())).toEqual(eventsBefore);
    },
  );

  it("rolls back Goal, lifecycle, and transcript when receipt persistence fails", async () => {
    await fillReceipts();
    const retained = database()
      .db.prepare("SELECT * FROM session_goal_operations ORDER BY operation_id")
      .all();
    const rejected = admit();
    await expect(rejected).rejects.toBeInstanceOf(SessionGoalOperationError);
    await expect(rejected).rejects.toMatchObject({ code: "capacity" });
    expect(loadSessionEntry(scope())).toMatchObject({ status: "done" });
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expect(await loadTranscriptEvents(scope())).toEqual([]);
    expect(
      await lookupSessionGoalOperation({
        ...scope(),
        expectedSessionId: sessionId,
        operation: startOperation(),
      }),
    ).toBeUndefined();
    expect(
      database().db.prepare("SELECT * FROM session_goal_operations ORDER BY operation_id").all(),
    ).toEqual(retained);
    await writeFixture((db) => {
      db.exec("DELETE FROM session_goal_operations");
    });
    await expect(admit()).resolves.toMatchObject({
      appendedCount: 1,
      sessionTurnMutationResult: { replayed: false },
    });
  });

  it("does not commit a Goal when admission skips its message", async () => {
    await expect(admit(startOperation(), { shouldAppend: () => false })).rejects.toThrow(
      "requires a new transcript turn",
    );
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expect(await loadTranscriptEvents(scope())).toEqual([]);
  });

  it("fences stale Goal controls and retains the clear receipt for exact retries", async () => {
    const goal = await createSessionGoal({ ...scope(), objective: "first" });
    const identityMutation = vi.fn();
    onTestFinished(onSessionIdentityMutation(identityMutation));
    const clear = { ...identity("clear-1"), action: "clear" as const, goalId: goal.id };
    const cleared = await mutateSessionGoal({
      ...scope(),
      expectedSessionId: sessionId,
      operation: clear,
    });
    expect(cleared.sessionEntry).toMatchObject({ sessionId, status: "done" });
    expect(identityMutation).not.toHaveBeenCalled();
    const replacement = await createSessionGoal({ ...scope(), objective: "second" });
    expect(
      await mutateSessionGoal({ ...scope(), expectedSessionId: sessionId, operation: clear }),
    ).toMatchObject({ result: cleared.result, replayed: true });
    await expect(
      mutateSessionGoal({
        ...scope(),
        expectedSessionId: sessionId,
        operation: { ...identity("pause-old"), action: "pause", goalId: goal.id },
      }),
    ).rejects.toMatchObject({ code: "goal-rebound" });
    expect(loadSessionEntry(scope())?.goal?.id).toBe(replacement.id);
    expect(await loadTranscriptEvents(scope())).toEqual([]);
  });

  it("commits Resume with its hidden continuation and the shared fresh budget window", async () => {
    const goal = await createSessionGoal({ ...scope(), objective: "finish", tokenBudget: 20 });
    await updateSessionGoalStatus({ ...scope(), status: "paused" });
    await upsertSessionEntryCore(scope(), { ...loadSessionEntry(scope())!, totalTokens: 130 });
    const mutation: SessionTranscriptTurnMutation = {
      kind: "goal",
      operation: { ...identity("resume-1"), action: "resume", goalId: goal.id },
      runId: "run-resume",
    };
    const resumed = await persistSessionTranscriptTurn(scope(), {
      expectedSessionId: sessionId,
      sessionTurnMutation: mutation,
      runId: mutation.runId,
      messages: [
        {
          message: {
            role: "user",
            content: "Continue the current Goal.",
            inputProvenance: { kind: "internal_system" },
            __openclaw: { visibility: { display: false } },
          },
        },
      ],
      sessionLifecyclePatch: { status: undefined },
      updateMode: "none",
    });
    expect(resumed.sessionTurnMutationResult?.result.goal).toMatchObject({
      id: goal.id,
      status: "active",
      tokensUsed: 0,
      tokenStart: 130,
    });
    expect(resumed.messages[0]?.message).toMatchObject({
      inputProvenance: { kind: "internal_system" },
      __openclaw: {
        visibility: { display: false },
        intent: { kind: "session-goal-resume", goalId: goal.id },
      },
    });
  });

  it("rejects receipt replay after the session generation rotates", async () => {
    await admit();
    await replaceSessionEntry(scope(), { sessionId: "goal-session-2", updatedAt: now });
    await expect(
      lookupSessionGoalOperation({
        ...scope(),
        expectedSessionId: sessionId,
        operation: startOperation(),
      }),
    ).rejects.toMatchObject({ code: "session-rebound" });
    await expect(admit()).resolves.toMatchObject({
      rejectedReason: "session-rebound",
      appendedCount: 0,
    });
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
  });

  it("rejects expired operations after pruning and preserves unexpired receipts at capacity", async () => {
    const db = database().db;
    await fillReceipts();
    await expect(admit()).rejects.toMatchObject({ code: "capacity" });
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expect(await loadTranscriptEvents(scope())).toEqual([]);
    await writeFixture((current) => {
      current.prepare("UPDATE session_goal_operations SET expires_at = ?").run(now - 1);
    });
    await admit();
    expect(db.prepare("SELECT count(*) AS count FROM session_goal_operations").get()).toEqual({
      count: 1,
    });
    await clearSessionGoal(scope());
    await writeFixture((current) => {
      current.prepare("DELETE FROM session_goal_operations").run();
    });
    await expect(
      admit({ ...startOperation(), issuedAtMs: now - 24 * 60 * 60 * 1000 }),
    ).rejects.toMatchObject({ code: "expired" });
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
  });

  it("rejects turn admission when authority closes during awaited message preparation", async () => {
    let current = true;
    const operation = startOperation();
    await expect(
      persistSessionTranscriptTurn(scope(), {
        expectedSessionId: sessionId,
        sessionTurnMutation: {
          kind: "goal",
          operation,
          runId: "run-1",
          assertCurrent: () => {
            if (!current) {
              throw new Error("authority closed");
            }
          },
        },
        messages: [
          {
            message: { role: "user", content: operation.objective },
            shouldAppend: async () => {
              current = false;
              return true;
            },
          },
        ],
        updateMode: "none",
      }),
    ).rejects.toThrow("authority closed");
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expect(await loadTranscriptEvents(scope())).toEqual([]);
    expect(
      await lookupSessionGoalOperation({ ...scope(), expectedSessionId: sessionId, operation }),
    ).toBeUndefined();
  });

  it("revalidates admission authority inside the queued commit before writing", async () => {
    const goal = await createSessionGoal({ ...scope(), objective: "finish" });
    await expect(
      mutateSessionGoal({
        ...scope(),
        expectedSessionId: sessionId,
        operation: { ...identity("pause-1"), action: "pause", goalId: goal.id },
        assertCurrent: () => {
          throw new Error("authority closed");
        },
      }),
    ).rejects.toThrow("authority closed");
    expect(loadSessionEntry(scope())?.goal?.status).toBe("active");
  });

  it("keeps later Goal edits behind an accepted edit's authority preparation", async () => {
    const goal = await createSessionGoal({ ...scope(), objective: "original" });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const first = mutateSessionGoal({
      ...scope(),
      expectedSessionId: sessionId,
      operation: { ...identity("fifo-first"), action: "edit", goalId: goal.id, objective: "first" },
      assertCurrent: Object.assign(() => {}, {
        async prepareSessionSource() {
          entered.resolve();
          await release.promise;
          return { assertCurrent() {}, checks: [] };
        },
      }),
    });
    let second: ReturnType<typeof mutateSessionGoal> | undefined;
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        first,
        "Goal edit skipped authority preparation",
      );
      second = mutateSessionGoal({
        ...scope(),
        expectedSessionId: sessionId,
        operation: {
          ...identity("fifo-second"),
          action: "edit",
          goalId: goal.id,
          objective: "second",
        },
      });
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
    expect((await first).result.goal?.objective).toBe("first");
    expect((await second)?.result.goal?.objective).toBe("second");
    expect(loadSessionEntry(scope())?.goal?.objective).toBe("second");
  });

  it.each([
    { stage: "transaction", failure: "revocation" },
    { stage: "commit", failure: "revocation" },
    { stage: "commit", failure: "expiry" },
  ] as const)(
    "rolls back management and its receipt after $stage $failure",
    async ({ stage, failure }) => {
      const goal = await createSessionGoal({ ...scope(), objective: "finish" });
      const operation = {
        ...identity(`pause-${stage}-${failure}`),
        action: "pause" as const,
        goalId: goal.id,
      };
      let admitted = false;
      const clock = vi.spyOn(Date, "now");
      const assertCurrent = () => {
        if (admitted) {
          if (failure === "revocation") {
            throw new Error("Goal caller closed");
          }
          clock.mockReturnValue(operation.issuedAtMs + 24 * 60 * 60 * 1000);
        }
      };
      probe.admission(workerAdmission, (request, grant, callback) => {
        if (
          request.stage === stage &&
          isRecord(request.facts) &&
          isRecord(request.facts.publication) &&
          request.facts.publication.kind ===
            (stage === "commit" ? "session-entry-patch-committed" : "session-entry-patch-transfer")
        ) {
          admitted = true;
        }
        callback(request, grant);
      });
      try {
        const mutation = mutateSessionGoal({
          ...scope(),
          expectedSessionId: sessionId,
          operation,
          assertCurrent: Object.assign(assertCurrent, {
            async prepareSessionSource() {
              return { assertCurrent, checks: [] };
            },
          }),
        });
        if (failure === "revocation") {
          await expect(mutation).rejects.toThrow("Goal caller closed");
        } else {
          await expect(mutation).rejects.toMatchObject({ code: "expired" });
        }
      } finally {
        clock.mockRestore();
      }
      expect(admitted).toBe(true);
      expect(loadSessionEntry(scope())?.goal).toEqual(goal);
      expect(
        await lookupSessionGoalOperation({ ...scope(), expectedSessionId: sessionId, operation }),
      ).toBeUndefined();
    },
  );
});
