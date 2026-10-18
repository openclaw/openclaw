import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { withSqliteDatabaseWriteScope } from "../../infra/sqlite-database-admission.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import type { HarnessCompletionRecovery } from "./restart-recovery-types.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type {
  SessionActorHotState,
  SessionActorPendingFinalDelivery,
} from "./session-actor-contract.js";
import { withActor, type Fixture, type Mutation } from "./session-actor-worker.test-support.js";
import { readPendingInput } from "./session-pending-input-operations.kernel.js";
import type { PendingInputMutation } from "./session-pending-input-operations.types.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import type { SessionEntry } from "./types.js";

// mock-isolation: Actor ownership proof must not schedule unrelated background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture owns its database lifetime without background history eviction.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

type Events = readonly TranscriptEvent[];

function seedEntry(f: Fixture, overrides: Partial<SessionEntry>, events: Events = []) {
  runSqliteImmediateTransactionSync(f.database.db, () => {
    writeSessionEntry(f.database, f.target.sessionKey, { ...f.nativeEntry()!, ...overrides });
    if (events.length) {
      appendTranscriptEventsInTransaction(f.database, f.scope, events);
    }
  });
}

function userEvent(id: string, content: string, message = {}, parentId: string | null = null) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01Z",
    message: { role: "user", content, idempotencyKey: id, ...message },
  };
}

function seedConversation(
  f: Fixture,
  entry: Partial<SessionEntry>,
  event: ReturnType<typeof userEvent>,
) {
  seedEntry(f, entry, [
    {
      type: "session",
      id: f.scope.sessionId,
      version: 3,
      timestamp: "2026-01-01T00:00:00Z",
      cwd: "/synthetic",
    },
    event,
  ]);
}

function pendingInput(
  f: Fixture,
  key: string,
  content: string,
  overrides: Partial<Extract<PendingInputMutation, { kind: "stage" }>>,
) {
  const pending = {
    kind: "stage" as const,
    sessionKey: f.target.sessionKey,
    sessionId: f.scope.sessionId,
    inputId: key,
    idempotencyKey: key,
    runId: "recovery-run",
    requestHash: key,
    lifecycleGeneration: "recovery-generation",
    trackCompletion: true,
    messageJson: JSON.stringify({ role: "user", content, idempotencyKey: key }),
    ...overrides,
  };
  const expected = readPendingInput(f.database, pending);
  if (expected.kind !== "stage") {
    throw new Error("Expected pending-input preparation");
  }
  return { ...pending, expected };
}

function recoveryClaim(
  f: Fixture,
  overrides: Partial<HarnessCompletionRecovery> = {},
): HarnessCompletionRecovery {
  return {
    taskId: "task",
    taskStatus: "succeeded",
    taskRunId: "task-run",
    sourceRunId: "source",
    requesterSessionKey: f.target.sessionKey,
    requesterAgentId: "main",
    sessionId: f.scope.sessionId,
    ...overrides,
  };
}

function expectRollback(outcome: ReturnType<Fixture["mutate"]>, message: string) {
  expect(outcome).toMatchObject({ kind: "rolled-back", error: { message } });
}

function commandInput(snapshot: SessionActorHotState, commandId: string, phaseId: string) {
  return { target: snapshot.target, expected: snapshot.version, commandId, phaseId };
}

function expectCommitted(outcome: ReturnType<Fixture["mutate"]>) {
  expect(outcome.kind).toBe("committed");
  if (outcome.kind !== "committed") {
    throw new Error("Expected native commit");
  }
  return outcome;
}

function patch(snapshot: SessionActorHotState, updatedAt: number): Mutation {
  return {
    type: "session.actor.patch",
    input: {
      ...commandInput(snapshot, `activity-${updatedAt}`, "terminal-accounting"),
      reducers: [{ kind: "activity", updatedAt }],
    },
  };
}

it("hydrates a cold command inside its transaction and returns a retryable preimage without rereading", () =>
  withActor(async (f) => {
    const command: Mutation = {
      type: "session.actor.patch",
      input: {
        target: f.target,
        commandId: "cold-patch",
        phaseId: "turn",
        reducers: [{ kind: "activity", updatedAt: 25 }],
      },
    };
    await f.prepare(command);
    const reads = trackSqliteStatementExecutions(f.database.db, ["select"], (sql) => {
      if (!/^select\b/iu.test(sql)) {
        return null;
      }
      expect(f.database.db.isTransaction).toBe(true);
      return "select";
    });
    try {
      const first = expectCommitted(f.mutate(command));
      expect(first.receipt.postimage.entry?.updatedAt).toBe(25);
      expect(reads.counts.select).toBe(1);
      f.restartActor();
      const stale = f.mutate(patch(first.receipt.postimage, 26));
      if (stale.kind !== "stale-version") {
        throw new Error("Expected replacement worker to return its current preimage");
      }
      expect(stale.expected).toEqual(first.receipt.afterVersion);
      expect(stale.postimage.entry?.updatedAt).toBe(25);
      expect(stale.postimage.version.epoch).not.toBe(first.receipt.afterVersion.epoch);
      expect(reads.counts.select).toBe(2);
      const retried = f.mutate(patch(stale.postimage, 26));
      expect(retried).toMatchObject({
        kind: "committed",
        receipt: {
          beforeVersion: stale.postimage.version,
          postimage: { entry: { updatedAt: 26 } },
        },
      });
      expect(reads.counts.select).toBe(2);
      expect(f.hooks.transactions).toBe(3);
    } finally {
      reads.restore();
    }
  }));

it("installs native commits before reply, retains known commits after reply failure, and rolls back revoked authority", () =>
  withActor(async (f) => {
    const initial = f.read();
    const command = patch(initial, 10);
    await f.prepare(command);
    f.hooks.afterTransaction = () => {
      throw new Error("synthetic reply failure after native commit");
    };
    const committed = expectCommitted(f.mutate(command));
    expect(committed.failure).toEqual({
      name: "Error",
      message: "synthetic reply failure after native commit",
    });
    expect(f.reply()).toEqual({ kind: "committed", failure: committed.failure });
    expect(committed.receipt).toMatchObject({
      beforeVersion: initial.version,
      afterVersion: { epoch: initial.version.epoch, sequence: 1 },
      transcript: { appendedMessages: [], projectionNeedsReconcile: false },
      reducers: [{ index: 0, kind: "activity", changed: true }],
      postimage: { entry: { updatedAt: 10 } },
    });
    expect(f.receipt()).toMatchObject({
      kind: "native-commit",
      committed: { facts: { kind: "committed", receipt: committed.receipt } },
    });
    expect(f.nativeEntry()?.updatedAt).toBe(10);
    delete f.hooks.afterTransaction;
    const current = f.read();
    expect(current.version).toEqual(committed.receipt.afterVersion);
    committed.receipt.postimage.entry!.updatedAt = 999;
    expect(f.read().entry?.updatedAt).toBe(10);

    f.hooks.admit = (stage) => {
      if (stage === "commit") {
        throw new Error("live run revoked before commit");
      }
    };
    expectRollback(f.mutate(patch(current, 20)), "live run revoked before commit");
    expect(f.receipt()).toBeUndefined();
    expect(f.nativeEntry()?.updatedAt).toBe(10);
    delete f.hooks.admit;
    expect(f.read().entry?.updatedAt).toBe(10);
  }));

it("fences a commit whose settlement is lost and rehydrates its durable state without replay", () =>
  withActor(async (f) => {
    const initial = f.read();
    const command = patch(initial, 30);
    await f.prepare(command);
    f.hooks.withCommit = (commit) => {
      commit();
      throw new Error("native commit returned without managed settlement");
    };
    const unknown = f.mutate(command);
    expect(unknown).toMatchObject({ kind: "unknown", commandId: "activity-30" });
    expect(f.database.db.isOpen).toBe(false);
    expect(f.receipt()).toBeUndefined();
    delete f.hooks.withCommit;
    await f.reopenDatabase();
    const writesBeforeRead = f.hooks.transactions;
    const recovered = f.read();
    expect(recovered.entry?.updatedAt).toBe(30);
    expect(recovered.version.epoch).not.toBe(initial.version.epoch);
    expect(f.hooks.transactions).toBe(writesBeforeRead);
    expect(f.mutate(command)).toMatchObject({
      kind: "stale-version",
      postimage: recovered,
      error: { message: "Session actor version changed before command admission" },
    });
    expect(f.hooks.transactions).toBe(writesBeforeRead + 1);
    expect(f.nativeEntry()?.updatedAt).toBe(30);
  }));

it("invalidates resident facts on native writes and keeps missing, replaced, and closed targets distinct", () =>
  withActor((f) => {
    const otherKey = "agent:main:other-native-writer";
    f.writeEntry({ sessionId: "other-session", updatedAt: 1 }, otherKey);
    const reads = trackSqliteStatementExecutions(f.database.db, ["select"], (sql) =>
      /^select\b/iu.test(sql) ? "select" : null,
    );
    try {
      const initial = f.read();
      expect(reads.counts.select).toBe(1);
      expect(f.read()).toEqual(initial);
      expect(reads.counts.select).toBe(1);
      using sibling = openNodeSqliteDatabase(f.database.path);
      withSqliteDatabaseWriteScope(sibling, [otherKey], () =>
        runSqliteImmediateTransactionSync(sibling, () => {
          sibling
            .prepare("UPDATE session_nodes SET updated_at = 2 WHERE session_key = ?")
            .run(otherKey);
        }),
      );
      expect(f.read()).toEqual(initial);
      expect(reads.counts.select).toBe(1);
      f.database.db
        .prepare(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?) WHERE session_key = ?",
        )
        .run("native writer", f.target.sessionKey);
      const replaced = f.read();
      expect(replaced.entry?.label).toBe("native writer");
      expect(replaced.version.epoch).not.toBe(initial.version.epoch);
      expect(reads.counts.select).toBe(2);
      expect(f.mutate(patch(initial, 40)).kind).toBe("stale-version");
      expect(f.hooks.transactions).toBe(1);

      const missing = f.read({ ...f.target, sessionKey: "agent:main:absent" });
      expect(missing.entry).toBeUndefined();
      expectRollback(f.mutate(patch(missing, 40)), "Session actor requires an existing session");
      expect(f.read(missing.target).entry).toBeUndefined();
      if (f.target.database.kind !== "file") {
        throw new Error("Expected durable target");
      }
      const other = {
        ...f.target,
        database: { ...f.target.database, physicalIdentity: "different-file" },
      };
      expect(() => f.read(other)).toThrow("lost its physical database owner");
      f.closeActor();
      expect(() => f.read()).toThrow("lost its physical database owner");
    } finally {
      reads.restore();
    }
  }));

it("evicts the least recently used settled actor and hydrates a new epoch after worker loss", () =>
  withActor((f) => {
    const initial = f.read();
    const inactive = Array.from({ length: 128 }, (_, index) => ({
      ...f.target,
      sessionKey: `agent:main:inactive-${index}`,
    }));
    const oldest = f.read(inactive[0]);
    for (const target of inactive.slice(1, 127)) {
      f.read(target);
    }
    expect(f.read().version).toEqual(initial.version);
    f.read(inactive[127]);
    expect(f.read().version).toEqual(initial.version);
    expect(f.read(inactive[0]).version.epoch).not.toBe(oldest.version.epoch);

    const beforeLoss = f.read();
    f.restartActor();
    f.hooks.admit = () => {
      throw new Error("old process run authority expired");
    };
    expect(() => f.read()).toThrow("old process run authority expired");
    delete f.hooks.admit;
    const rehydrated = f.read();
    expect(rehydrated.entry).toEqual(beforeLoss.entry);
    expect(rehydrated.version.epoch).not.toBe(beforeLoss.version.epoch);
    expect(f.hooks.transactions).toBe(0);
  }));

it("adopts a run only under the exact lifecycle and current transaction and commit authority", () =>
  withActor(async (f) => {
    const initial = f.read();
    const command: Mutation = {
      type: "session.actor.adoptRun",
      input: {
        ...commandInput(initial, "adopt-first", "adoption"),
        sessionId: f.scope.sessionId,
        expectedState: buildRestartRecoveryExpectedState(initial.entry!),
        runId: "current-run",
        lifecycle: { restartRecoveryBeforeAgentReplyState: "pending", startedAt: 2 },
      },
    };
    await f.prepare(command);
    expect(f.mutate(command).kind).toBe("committed");
    const adopted = f.read();
    expect(adopted.entry).toMatchObject({
      activeWriterRunId: "current-run",
      restartRecoveryBeforeAgentReplyState: "pending",
    });
    expectRollback(
      f.mutate({ ...command, input: { ...command.input, expected: adopted.version } }),
      "Session actor lifecycle changed before its durable phase",
    );
    const live = f.read();
    f.hooks.admit = (stage) => {
      if (stage === "transaction") {
        throw new Error("placement expired at effect boundary");
      }
    };
    expectRollback(f.mutate(patch(live, 50)), "placement expired at effect boundary");
    delete f.hooks.admit;
    expect(f.nativeEntry()).toMatchObject({
      activeWriterRunId: "current-run",
      restartRecoveryBeforeAgentReplyState: "pending",
    });
    expect(f.nativeEntry()?.updatedAt).not.toBe(50);
  }));

it.each([
  { phase: "acceptInput", initial: true, cold: false },
  { phase: "acceptInput", initial: false, cold: false },
  { phase: "adoptRun", initial: false, cold: false },
  { phase: "acceptInput", initial: false, cold: true },
  { phase: "adoptRun", initial: false, cold: true },
] as const)(
  "commits $phase transcript custody and lifecycle together (initial=$initial, cold=$cold)",
  (mode) =>
    withActor(async (f) => {
      const target = mode.initial
        ? { ...f.target, sessionKey: "agent:main:first-input" }
        : f.target;
      if (mode.cold) {
        seedEntry(f, { status: "done", restartRecoveryTerminalRunIds: ["previous-run"] });
      }
      const before = mode.cold ? undefined : f.read(target);
      const sessionId = mode.initial ? "first-input" : f.scope.sessionId;
      const expectedState = buildRestartRecoveryExpectedState(
        (mode.cold ? f.nativeEntry() : before?.entry) ?? { sessionId, updatedAt: 1 },
      );
      const lifecycle = { restartRecoveryDeliveryRunId: "input-run", startedAt: 2 };
      const turn = {
        agentId: "main",
        sessionKey: target.sessionKey,
        options: {
          expectedSessionId: sessionId,
          ...(mode.initial ? { initialSessionEntry: { sessionId, updatedAt: 1 } } : {}),
          sessionFile: "synthetic.jsonl",
          messages: [
            {
              eventId: "accepted-message",
              message: { role: "user", content: "accepted bytes", idempotencyKey: "accepted-once" },
            },
          ],
        },
      };
      const input = {
        target,
        expected: before?.version,
        commandId: "accept-transcript",
        phaseId: "input",
        expectedState,
        lifecycle,
        turn,
      };
      const command: Mutation =
        mode.phase === "acceptInput"
          ? { type: "session.actor.acceptInput", input }
          : { type: "session.actor.adoptRun", input: { ...input, sessionId } };
      await f.prepare(command);
      const transactions = f.hooks.transactions;
      const committed = expectCommitted(f.mutate(command));
      expect(committed.receipt).toMatchObject({
        transcript: {
          appendedMessages: [
            {
              appended: true,
              messageId: "accepted-message",
              message: { content: "accepted bytes" },
            },
          ],
        },
        postimage: {
          entry: { sessionId, ...lifecycle },
          pendingInputs: [],
        },
      });
      expect(f.hooks.transactions - transactions).toBe(1);
      expect(
        readTranscriptEventRows(f.database, sessionId).map((row) => JSON.parse(row.eventJson)),
      ).toEqual([
        expect.objectContaining({ type: "session", id: sessionId }),
        expect.objectContaining({
          type: "message",
          id: "accepted-message",
          message: expect.objectContaining({ content: "accepted bytes" }),
        }),
      ]);
      expect(f.read(target).entry).toEqual(committed.receipt.postimage.entry);
      if (mode.cold) {
        expect(f.nativeEntry()?.restartRecoveryTerminalRunIds).toEqual(["previous-run"]);
      }
    }),
);

it.each([
  { stored: "current-generation", requested: null },
  { stored: undefined, requested: "old-generation" },
])("refuses raw appends across nullable lifecycle revisions: %j", ({ stored, requested }) =>
  withActor(async (f) => {
    seedEntry(f, { lifecycleRevision: stored });
    const before = f.read();
    const events = readTranscriptEventRows(f.database, f.scope.sessionId);
    const command: Mutation = {
      type: "session.actor.appendTranscriptEvent",
      input: {
        ...commandInput(before, "stale-model-change", "model"),
        sessionId: f.scope.sessionId,
        lifecycleRevision: requested,
        eventJson: JSON.stringify({
          type: "model_change",
          id: "stale-model",
          parentId: null,
          timestamp: "2026-01-01T00:00:00Z",
          provider: "synthetic",
          modelId: "test-model",
        }),
      },
    };
    await f.prepare(command);
    expectRollback(f.mutate(command), "Session actor transcript lifecycle changed before append");
    expect(f.receipt()).toBeUndefined();
    expect(f.nativeEntry()).toEqual(before.entry);
    expect(readTranscriptEventRows(f.database, f.scope.sessionId)).toEqual(events);
  }),
);

it("stages queued custody without rewriting the active session lifecycle", () =>
  withActor(async (f) => {
    const before = f.read();
    const pending = pendingInput(f, "queued-input", "queued", {
      runId: "queued-run",
      requestHash: "queued-request",
      lifecycleGeneration: "queued-generation",
    });
    const writes = trackSqliteStatementExecutions(f.database.db, ["entry"], (sql) =>
      /^\s*(?:insert|update|delete)\b.*\bsession_nodes\b/isu.test(sql) ? "entry" : null,
    );
    try {
      expect(
        f.mutate({
          type: "session.actor.acceptInput",
          input: {
            ...commandInput(before, "stage-only", "input"),
            expectedState: buildRestartRecoveryExpectedState(before.entry!),
            lifecycle: {},
            pending,
          },
        }),
      ).toMatchObject({
        kind: "committed",
        receipt: {
          postimage: { entry: before.entry, pendingInputs: [{ input_id: "queued-input" }] },
        },
      });
      expect(writes.counts.entry).toBe(0);
    } finally {
      writes.restore();
    }
    expect(f.nativeEntry()).toEqual(before.entry);
  }));
it.each(["assistant append", "empty append", "bookkeeping"] as const)(
  "commits terminal custody and guarded accounting atomically with %s",
  (mode) =>
    withActor(async (f) => {
      seedConversation(
        f,
        {
          activeWriterRunId: "terminal-run",
          modelProvider: "openai",
          model: "fixture-before",
        },
        userEvent("turn-input", "question"),
      );
      const initial = f.read();
      const originalEvents = readTranscriptEventRows(f.database, f.scope.sessionId);
      const pending: SessionActorPendingFinalDelivery = {
        kind: "replayable",
        text: "final response",
        createdAt: 50,
        intentId: "terminal-intent",
        deliveries: [{ id: "terminal-payload", state: "prepared" }],
      };
      const complete = (
        snapshot: SessionActorHotState,
        expectedModel: string,
      ): Extract<Mutation, { type: "session.actor.completeTurn" }> => ({
        type: "session.actor.completeTurn",
        input: {
          ...commandInput(snapshot, `complete-${expectedModel}`, "terminal"),
          pendingFinalDelivery: pending,
          ...(mode === "bookkeeping"
            ? {
                bookkeeping: {
                  sessionId: f.scope.sessionId,
                  lifecycleRevision: snapshot.entry!.lifecycleRevision ?? null,
                  writerRunId: "terminal-run",
                  expectedState: buildRestartRecoveryExpectedState(snapshot.entry!),
                  lifecycle: { status: "done" as const, endedAt: 50 },
                },
              }
            : {
                turn: {
                  agentId: "main",
                  sessionKey: f.target.sessionKey,
                  options: {
                    expectedSessionId: f.scope.sessionId,
                    expectedWriterRunId: "terminal-run",
                    expectedSessionState: buildRestartRecoveryExpectedState(snapshot.entry!),
                    sessionLifecyclePatch: { status: "done", endedAt: 50 },
                    sessionFile: "synthetic.jsonl",
                    messages:
                      mode === "assistant append"
                        ? [
                            {
                              eventId: "terminal-answer",
                              message: {
                                role: "assistant",
                                content: "final response",
                                idempotencyKey: "terminal-answer",
                              },
                            },
                          ]
                        : [],
                  },
                },
              }),
          reducers: [
            { kind: "activity", updatedAt: 60 },
            {
              kind: "live-model",
              expected: { modelProvider: "openai", model: expectedModel },
              next: { modelProvider: "openai", model: "fixture-after" },
            },
            { kind: "group-intro", needsSystemIntro: false },
          ],
        },
      });
      const fresh = f.read();
      const staleOwner = complete(fresh, "fixture-before");
      if (staleOwner.input.bookkeeping) {
        staleOwner.input.bookkeeping.writerRunId = "superseded-run";
      } else {
        staleOwner.input.turn.options.expectedWriterRunId = "superseded-run";
      }
      expect(f.mutate(staleOwner)).toMatchObject({
        kind: "rolled-back",
        reason: "stale-state",
      });
      expect(f.receipt()).toBeUndefined();
      expect(f.nativeEntry()).toEqual(initial.entry);
      expect(readTranscriptEventRows(f.database, f.scope.sessionId)).toEqual(originalEvents);

      const native = vi.spyOn(f.database.db, "exec");
      const clock = vi.spyOn(Date, "now").mockReturnValue(55);
      let committed: ReturnType<Fixture["mutate"]>;
      try {
        committed = f.mutate(complete(fresh, "fixture-before"));
        expect(
          native.mock.calls
            .filter(([sql]) => /^(BEGIN|COMMIT|SAVEPOINT)\b/iu.test(sql))
            .map(([sql]) => sql),
        ).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
      } finally {
        clock.mockRestore();
        native.mockRestore();
      }
      committed = expectCommitted(committed);
      expect(committed.failure).toBeUndefined();
      expect(committed.receipt).toMatchObject({
        phase: "completeTurn",
        beforeVersion: fresh.version,
        afterVersion: { epoch: fresh.version.epoch, sequence: fresh.version.sequence + 1 },
        pendingFinalDelivery: pending,
        reducers: [
          { index: 0, kind: "activity", changed: true },
          { index: 1, kind: "live-model", changed: true },
          { index: 2, kind: "group-intro", changed: true },
        ],
        postimage: {
          entry: {
            updatedAt: 60,
            model: "fixture-after",
            groupActivationNeedsSystemIntro: false,
            pendingFinalDelivery: pending,
            status: "done",
            endedAt: 50,
          },
        },
      });
      expect(committed.value).toMatchObject(
        mode === "bookkeeping"
          ? { kind: "bookkeeping" }
          : {
              kind: "session-turn",
              result: { sessionEntry: committed.receipt.postimage.entry },
            },
      );
      const appended = committed.receipt.transcript.appendedMessages;
      if (mode === "assistant append") {
        expect(appended).toMatchObject([
          { appended: true, messageId: "terminal-answer", effectiveParentId: "turn-input" },
        ]);
      } else {
        expect(appended).toEqual([]);
        expect(committed.receipt.transcript.after).toEqual(initial.transcript.version);
      }
      expect(f.receipt()).toMatchObject({
        kind: "native-commit",
        committed: { facts: { receipt: committed.receipt } },
      });
      expect(f.nativeEntry()).toEqual(committed.receipt.postimage.entry);
      f.restartActor();
      const rehydrated = f.read();
      expect(rehydrated.entry?.pendingFinalDelivery).toEqual(pending);
      expect(rehydrated.entry?.model).toBe("fixture-after");
      expect(rehydrated.entry).toMatchObject({ status: "done", endedAt: 50 });
      expect(rehydrated.transcript.version).toEqual(committed.receipt.transcript.after);
      expect(readTranscriptEventRows(f.database, f.scope.sessionId)).toHaveLength(
        originalEvents.length + (mode === "assistant append" ? 1 : 0),
      );
      const mismatch = f.mutate({
        type: "session.actor.patch",
        input: {
          ...commandInput(rehydrated, "superseded-model-selection", "terminal"),
          reducers: [
            {
              kind: "live-model",
              expected: { modelProvider: "openai", model: "fixture-before" },
              next: { modelProvider: "openai", model: "must-not-replace-current-selection" },
              clearPending: true,
            },
          ],
        },
      });
      expect(mismatch).toMatchObject({
        kind: "committed",
        receipt: { reducers: [{ kind: "live-model", changed: false }] },
      });
      expect(f.nativeEntry()?.model).toBe("fixture-after");
    }),
);

it("keeps restart receipt custody across retries and settles only the exact provider claim", () =>
  withActor((f) => {
    const claim = { sessionId: f.scope.sessionId, sourceTurnId: "source", toolCallId: "tool" };
    seedEntry(f, {
      restartRecoveryDeliveryRunId: "run",
      restartRecoveryDeliverySourceRunId: claim.sourceTurnId,
    });
    let sequence = 0;
    const common = () => ({
      target: f.target,
      expected: f.read().version,
      commandId: `receipt-${++sequence}`,
      phaseId: "delivery",
    });
    const settle = (outcome: "confirmed" | "not-sent", toolCallId = claim.toolCallId) =>
      f.mutate({
        type: "session.actor.deliverySettled",
        input: {
          ...common(),
          restart: { claim: { ...claim, toolCallId }, outcome, updatedAt: 20 },
        },
      });
    expect(
      f.mutate({
        type: "session.actor.deliveryPending",
        input: { ...common(), claim, updatedAt: 10 },
      }),
    ).toMatchObject({ kind: "committed", value: { disposition: "started" } });
    expect(f.nativeEntry()).toMatchObject({
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryToolCallId: claim.toolCallId,
    });
    expect(
      f.mutate({
        type: "session.actor.deliveryPending",
        input: { ...common(), claim, updatedAt: 11 },
      }),
    ).toMatchObject({ kind: "committed", value: { disposition: "delivery-ambiguous" } });
    expect(settle("confirmed", "unrelated-tool")).toMatchObject({ kind: "rolled-back" });
    expect(f.nativeEntry()?.restartRecoveryDeliveryReceiptState).toBe("terminal-pending");
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(settle("confirmed")).toMatchObject({
        kind: "committed",
        value: { disposition: "recorded" },
      });
    }
    expect(settle("not-sent")).toMatchObject({
      kind: "committed",
      value: { disposition: "stale" },
    });
    expect(f.nativeEntry()?.restartRecoveryDeliveryReceiptState).toBe("delivered-terminal");
    const nextClaim = { ...claim, sourceTurnId: "next-source" };
    seedEntry(f, {
      restartRecoveryDeliverySourceRunId: nextClaim.sourceTurnId,
      restartRecoveryDeliveryReceiptState: "terminal-pending",
    });
    for (const commandId of ["cancel", "cancel-replay"]) {
      expect(
        f.mutate({
          type: "session.actor.deliverySettled",
          input: {
            ...common(),
            commandId,
            restart: { claim: nextClaim, outcome: "not-sent", updatedAt: 30 },
          },
        }),
      ).toMatchObject({ kind: "committed", value: { disposition: "cleared" } });
    }
    expect(f.nativeEntry()?.restartRecoveryDeliveryReceiptState).toBeUndefined();
    expect(f.nativeEntry()?.restartRecoveryDeliveryToolCallId).toBeUndefined();
  }));

it("publishes actual pending-final state and evidence only after live commit authority", () =>
  withActor((f) => {
    const claim = recoveryClaim(f);
    seedEntry(f, {
      abortedLastRun: true,
      mainRestartRecovery: { cycleId: "cycle", revision: 2, chargedAttempts: 0 },
      pendingFinalDelivery: {
        kind: "replayable",
        text: "answer",
        createdAt: 10,
        intentId: "intent",
        context: { channel: "telegram", to: "chat" },
        deliveries: [{ id: "payload", state: "queued" }],
      },
    });
    const initial = f.read();
    const command = {
      type: "session.actor.deliverySettled",
      input: {
        ...commandInput(initial, "settle", "delivery"),
        settlement: {
          sessionId: f.scope.sessionId,
          intentId: "intent",
          deliveryId: "payload",
          state: "delivered",
        },
        evidence: {
          claim,
          result: { channel: "telegram", target: { id: "chat" }, platformMessageId: "message" },
        },
      },
    } satisfies Mutation;
    f.hooks.admit = (stage) => {
      if (stage === "commit") {
        throw new Error("harness claim revoked");
      }
    };
    expect(f.mutate(command)).toMatchObject({ kind: "rolled-back" });
    expect(f.nativeEntry()).toEqual(initial.entry);
    delete f.hooks.admit;
    expect(
      f.mutate({ ...command, input: { ...command.input, expected: f.read().version } }),
    ).toMatchObject({
      kind: "committed",
      value: { state: "delivered", wakeRecovery: true },
      receipt: {
        postimage: {
          entry: {
            mainRestartRecovery: { revision: 3 },
            restartRecoveryTerminalDeliveryEvidence: [
              {
                harnessCompletion: claim,
                durableFinalReceipt: {
                  intentId: "intent",
                  deliveryId: "payload",
                  platformMessageId: "message",
                },
              },
            ],
          },
        },
      },
    });
    expect(
      f.mutate({
        ...command,
        input: {
          ...command.input,
          expected: f.read().version,
          commandId: "replay",
          evidence: undefined,
        },
      }),
    ).toMatchObject({ kind: "committed", value: { state: "delivered", wakeRecovery: false } });
  }));

it("checks recovery provenance in the actor transaction and refuses a later unrelated input", () =>
  withActor(async (f) => {
    const claim = recoveryClaim(f, {
      sourceRunId: "source-run",
      lifecycleRevision: "recovery-generation",
    });
    seedConversation(
      f,
      {
        activeWriterRunId: "recovery-run",
        restartRecoveryDeliveryRunId: "recovery-run",
        lifecycleRevision: claim.lifecycleRevision,
      },
      userEvent("completion-source", "task completed", {
        idempotencyKey: "source-run:user",
        __openclaw: { runId: "source-run" },
        provenance: {
          kind: "inter_session",
          sourceChannel: "internal",
          sourceTool: "agent_harness_completion",
          sourceSessionKey: "task-run",
        },
      }),
    );
    const makeCommand = (key: string): Mutation => {
      const current = f.read();
      const pending = pendingInput(f, key, "resume", {});
      return {
        type: "session.actor.acceptInput",
        input: {
          ...commandInput(current, key, "recovery"),
          expectedState: buildRestartRecoveryExpectedState(current.entry!),
          lifecycle: { restartRecoveryBeforeAgentReplyState: "admitted" },
          recovery: { expectedRunId: "recovery-run", sources: [], harnessCompletion: claim },
          pending,
        },
      };
    };
    const command = makeCommand("accepted-recovery");
    await f.prepare(command);
    {
      using exec = vi.spyOn(f.database.db, "exec");
      expect(f.mutate(command)).toMatchObject({
        kind: "committed",
        receipt: {
          pendingInputMutationReceipt: { operation: "stage", idempotencyKey: "accepted-recovery" },
          postimage: { pendingInputs: [{ input_id: "accepted-recovery" }] },
        },
      });
      expect(exec.mock.calls.filter(([sql]) => /^SAVEPOINT\b/iu.test(sql))).toEqual([]);
    }
    runSqliteImmediateTransactionSync(f.database.db, () =>
      appendTranscriptEventsInTransaction(f.database, f.scope, [
        {
          ...userEvent(
            "later-human",
            "a different request",
            { idempotencyKey: "unrelated-input" },
            "completion-source",
          ),
          timestamp: "2026-01-01T00:00:02Z",
        },
      ]),
    );
    expectRollback(
      f.mutate(makeCommand("refused-recovery")),
      "Session actor recovery input no longer matches its source",
    );
    expect(f.read().pendingInputs.map((row) => row.input_id)).toEqual(["accepted-recovery"]);
  }));
