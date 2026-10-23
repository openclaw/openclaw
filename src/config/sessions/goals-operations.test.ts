import { existsSync } from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
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
  afterAll(clearRuntimeConfigSnapshot);
  const fixture = useTempSessionsFixture("openclaw-goal-operations-");
  const sessionKey = "agent:main:goal-operations";
  const sessionId = "goal-session-1";
  const now = Date.now();
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const goalRequest = (operation: SessionGoalOperation = startOperation()) => ({
    ...scope(),
    expectedSessionId: sessionId,
    operation,
  });
  const lookupReceipt = (operation?: SessionGoalOperation) =>
    lookupSessionGoalOperation(goalRequest(operation));
  const mutate = (
    operation: Parameters<typeof mutateSessionGoal>[0]["operation"],
    assertCurrent?: Parameters<typeof mutateSessionGoal>[0]["assertCurrent"],
  ) => mutateSessionGoal({ ...scope(), expectedSessionId: sessionId, operation, assertCurrent });
  const createGoal = (objective: string, tokenBudget?: number) =>
    createSessionGoal({ ...scope(), objective, tokenBudget });
  const editOperation = (operationId: string, goalId: string, objective: string) =>
    ({ ...identity(operationId), action: "edit", goalId, objective }) as const;
  const watchIdentity = () => {
    const listener = vi.fn();
    onTestFinished(onSessionIdentityMutation(listener));
    return listener;
  };
  const receipts = () =>
    database().db.prepare("SELECT * FROM session_goal_operations ORDER BY operation_id").all();
  const expectNoTurn = async () => {
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expect(await loadTranscriptEvents(scope())).toEqual([]);
  };
  const trackReads = () =>
    trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database().db),
      ["sessionNodeSelects", "receiptStatements"],
      (sql) =>
        /^select\b/i.test(sql) && /\bfrom\s+"session_nodes"/i.test(sql)
          ? "sessionNodeSelects"
          : /\b(?:from|into)\s+"session_goal_operations"/i.test(sql)
            ? "receiptStatements"
            : null,
    );
  const withoutNodeReads = async <T>(run: () => Promise<T>, noReceipts = false) => {
    const reads = trackReads();
    try {
      const result = await run();
      for (const counts of [reads.counts, reads.rowCounts, reads.textBytes]) {
        expect.soft(counts.sessionNodeSelects).toBe(0);
      }
      if (noReceipts) {
        expect.soft(reads.counts.receiptStatements).toBe(0);
      }
      return result;
    } finally {
      reads.restore();
    }
  };
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
  const writeSql = (sql: string, ...params: SQLInputValue[]) =>
    writeFixture((db) => {
      db.prepare(sql).run(...params);
    });
  const fillReceipts = () =>
    writeSql(
      `WITH RECURSIVE receipts(i) AS (
          VALUES (0) UNION ALL SELECT i + 1 FROM receipts WHERE i < 4095
        ) INSERT INTO session_goal_operations
          SELECT ?, 'retained-' || i, ?, 'fingerprint', '{}', ? FROM receipts`,
      sessionKey,
      sessionId,
      Number.MAX_SAFE_INTEGER,
    );
  const persistTurn = (options: Parameters<typeof persistSessionTranscriptTurn>[1]) =>
    persistSessionTranscriptTurn(scope(), {
      expectedSessionId: sessionId,
      updateMode: "none",
      ...options,
    });
  const admit = (operation = startOperation(), extra: { shouldAppend?: () => boolean } = {}) =>
    persistTurn({
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
    });

  beforeEach(async () => {
    setRuntimeConfigSnapshot({});
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
    const lookup = goalRequest();
    const missing = path.join(path.dirname(database().path), "missing", "agent.sqlite");
    await expect(
      lookupSessionGoalOperation({ ...lookup, storePath: missing }),
    ).resolves.toBeUndefined();
    expect(existsSync(missing)).toBe(false);
    await writeSql("DROP TABLE session_goal_operations");
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
    const identityMutation = watchIdentity();
    const turn = await withoutNodeReads(admit);
    expect(identityMutation).not.toHaveBeenCalled();
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
    expect(await lookupReceipt()).toEqual(receipt);
    const editedObjective = "\t resume the café migration 🦞\n/keep every byte ";
    const operation = editOperation("edit-literal", receipt!.goalId, editedObjective);
    const assertCurrent = Object.assign(vi.fn(), { nativeSource: true });
    const edited = await withoutNodeReads(() => mutate(operation, assertCurrent), true);
    expect(assertCurrent).toHaveBeenCalled();
    expect(identityMutation).not.toHaveBeenCalled();
    expect(hasPendingCanonicalSessionValidation(database())).toBe(false);
    expect(edited.sessionEntry).toMatchObject({ sessionId, lastRunId: "run-1" });
    expect(edited.sessionEntry?.status).toBeUndefined();
    expect(edited.result.goal?.objective).toBe(editedObjective);
    expect(edited.sessionEntry?.skillsSnapshot).toEqual(skillsSnapshot);
    expect(loadSessionEntry(scope())?.goal?.objective).toBe(editedObjective);
    expect(await lookupReceipt(operation)).toEqual(edited.result);
  });

  it("edits only the exact case-sensitive session without publishing an identity change", async () => {
    const target = { ...scope(), sessionKey: "agent:main:matrix:group:!Room:example.org" };
    const sibling = { ...scope(), sessionKey: "agent:main:matrix:group:!room:example.org" };
    await replaceSessionEntry(target, { sessionId, updatedAt: now });
    await replaceSessionEntry(sibling, { sessionId: "sibling-session", updatedAt: now });
    const goal = await createSessionGoal({ ...target, objective: "target objective" });
    await createSessionGoal({ ...sibling, objective: "sibling objective" });
    const beforeSibling = loadSessionEntry(sibling);
    const identityMutation = watchIdentity();
    const edited = await mutateSessionGoal({
      ...target,
      expectedSessionId: sessionId,
      operation: editOperation("edit-case-sensitive", goal.id, "updated target"),
    });
    expect(edited.result.goal?.objective).toBe("updated target");
    expect(loadSessionEntry(target)?.goal?.objective).toBe("updated target");
    expect(loadSessionEntry(sibling)).toEqual(beforeSibling);
    expect(identityMutation).not.toHaveBeenCalled();
  });

  it("replays the original success after clear and reopening without recreating Goal or turn", async () => {
    const first = await admit();
    await clearSessionGoal(scope());
    const eventsBefore = await loadTranscriptEvents(scope());
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await expect(lookupReceipt()).resolves.toEqual(first.sessionTurnMutationResult?.result);
    const conflict = lookupReceipt({
      ...startOperation(),
      requestFingerprint: "different-attachment",
    });
    await expect(conflict).rejects.toBeInstanceOf(SessionGoalOperationError);
    await expect(conflict).rejects.toMatchObject({ code: "operation-conflict" });
    const replay = await admit();
    expect(replay.sessionTurnMutationResult).toEqual({
      result: first.sessionTurnMutationResult?.result,
      replayed: true,
    });
    expect(replay.messages.filter((m) => m.appended)).toHaveLength(0);
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
    const replay = await persistTurn({
      expectedLifecycleRevision: "previous-writer",
      sessionTurnMutation: { kind: "goal", operation: startOperation(), runId: "run-1" },
      messages: [{ message: { role: "user", content: "must not append" } }],
    });
    expect(replay).toMatchObject({
      messages: [],
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
      await writeSql(
        "UPDATE session_goal_operations SET result_json = ? WHERE operation_id = ?",
        corrupt,
        "start-1",
      );
      const eventsBefore = await loadTranscriptEvents(scope());
      await expect(lookupReceipt()).rejects.toMatchObject({ code: "receipt-invalid" });
      await expect(admit()).rejects.toMatchObject({ code: "receipt-invalid" });
      expect(loadSessionEntry(scope())?.goal).toBeUndefined();
      expect(await loadTranscriptEvents(scope())).toEqual(eventsBefore);
    },
  );

  it("rolls back full receipt stores, prunes expired receipts, and rejects expired retries", async () => {
    await fillReceipts();
    const retained = receipts();
    const rejected = admit();
    await expect(rejected).rejects.toBeInstanceOf(SessionGoalOperationError);
    await expect(rejected).rejects.toMatchObject({ code: "capacity" });
    expect(loadSessionEntry(scope())).toMatchObject({ status: "done" });
    await expectNoTurn();
    expect(await lookupReceipt()).toBeUndefined();
    expect(receipts()).toEqual(retained);
    await writeSql("DELETE FROM session_goal_operations WHERE operation_id = ?", "retained-0");
    const accepted = await admit();
    expect(accepted).toMatchObject({
      messages: [{ appended: true }],
      sessionTurnMutationResult: { replayed: false },
    });
    const acceptedEntry = loadSessionEntry(scope());
    const acceptedReceipts = receipts();
    expect(acceptedReceipts).toHaveLength(4096);
    await expect(
      mutate(
        editOperation(
          "edit-at-capacity",
          accepted.sessionTurnMutationResult!.result.goalId,
          "must not commit",
        ),
      ),
    ).rejects.toMatchObject({ code: "capacity" });
    expect(loadSessionEntry(scope())).toEqual(acceptedEntry);
    expect(receipts()).toEqual(acceptedReceipts);

    await clearSessionGoal(scope());
    await writeSql("UPDATE session_goal_operations SET expires_at = ?", now - 1);
    const prunedOperation = { ...startOperation(), ...identity("start-after-pruning") };
    await admit(prunedOperation);
    expect(receipts()).toHaveLength(1);
    await clearSessionGoal(scope());
    await writeSql("DELETE FROM session_goal_operations");
    await expect(
      admit({ ...prunedOperation, issuedAtMs: now - 24 * 60 * 60 * 1000 }),
    ).rejects.toMatchObject({ code: "expired" });
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
  });

  it("does not commit a Goal when admission skips its message", async () => {
    await expect(admit(startOperation(), { shouldAppend: () => false })).rejects.toThrow(
      "requires a new transcript turn",
    );
    await expectNoTurn();
  });

  it("fences stale Goal controls and retains the clear receipt for exact retries", async () => {
    const goal = await createGoal("first");
    const identityMutation = watchIdentity();
    const clear = { ...identity("clear-1"), action: "clear" as const, goalId: goal.id };
    const cleared = await mutate(clear);
    expect(cleared.sessionEntry).toMatchObject({ sessionId, status: "done" });
    expect(identityMutation).not.toHaveBeenCalled();
    const replacement = await createGoal("second");
    expect(await mutate(clear)).toMatchObject({ result: cleared.result, replayed: true });
    await expect(
      mutate({ ...identity("pause-old"), action: "pause", goalId: goal.id }),
    ).rejects.toMatchObject({ code: "goal-rebound" });
    expect(loadSessionEntry(scope())?.goal?.id).toBe(replacement.id);
    expect(await loadTranscriptEvents(scope())).toEqual([]);
  });

  it("commits Resume with its hidden continuation and the shared fresh budget window", async () => {
    const goal = await createGoal("finish", 20);
    await updateSessionGoalStatus({ ...scope(), status: "paused" });
    await upsertSessionEntryCore(scope(), { ...loadSessionEntry(scope())!, totalTokens: 130 });
    const mutation: SessionTranscriptTurnMutation = {
      kind: "goal",
      operation: { ...identity("resume-1"), action: "resume", goalId: goal.id },
      runId: "run-resume",
    };
    const resumed = await persistTurn({
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
    await expect(lookupReceipt()).rejects.toMatchObject({ code: "session-rebound" });
    await expect(admit()).resolves.toMatchObject({
      rejectedReason: "session-rebound",
      messages: [],
    });
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
  });

  it("rejects turn admission when authority closes during awaited message preparation", async () => {
    let current = true;
    const operation = startOperation();
    await expect(
      persistTurn({
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
      }),
    ).rejects.toThrow("authority closed");
    await expectNoTurn();
    expect(await lookupReceipt(operation)).toBeUndefined();
  });

  it("keeps later Goal edits behind an accepted edit's authority preparation", async () => {
    const goal = await createGoal("original");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const first = mutate(
      editOperation("fifo-first", goal.id, "first"),
      Object.assign(() => {}, {
        async prepareSessionSource() {
          entered.resolve();
          await release.promise;
          return { assertCurrent() {}, checks: [] };
        },
      }),
    );
    let second: ReturnType<typeof mutateSessionGoal> | undefined;
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        first,
        "Goal edit skipped authority preparation",
      );
      second = mutate(editOperation("fifo-second", goal.id, "second"));
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
      const goal = await createGoal("finish");
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
          (stage === "transaction"
            ? request.facts.publication === undefined
            : isRecord(request.facts.publication) &&
              request.facts.publication.kind === "session-entry-patch-committed")
        ) {
          admitted = true;
        }
        callback(request, grant);
      });
      try {
        const mutation = mutate(
          operation,
          Object.assign(assertCurrent, {
            async prepareSessionSource() {
              return { assertCurrent, checks: [] };
            },
          }),
        );
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
      expect(await lookupReceipt(operation)).toBeUndefined();
    },
  );
});
