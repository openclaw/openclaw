import { assert, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import {
  ensureSessionInputCompletionsSchema,
  ensureSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import {
  deleteSessionEntryRows,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import {
  readSessionInputCompletion,
  writeSessionInputCompletion,
  readSessionPendingInputByKey,
} from "./session-accessor.sqlite-pending-inputs.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import {
  canRebasePreparedAssistantInTransaction,
  isTranscriptEntryOnActivePathInTransaction,
  readTranscriptVisibleTailEntryIdInTransaction,
  resolveTranscriptMessageAppendParent,
} from "./session-accessor.sqlite-transcript-parent.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { applySessionActorAppend } from "./session-actor-append.worker.js";
import { initializeSessionActorContextStats } from "./session-actor-context-stats.worker.js";
import type { SessionActorAppend } from "./session-actor-contract.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import {
  hydrateSessionActorState,
  projectSessionActorHotState,
} from "./session-actor-hydration.worker.js";
import { createSessionActorResidency } from "./session-actor-residency.worker.js";
import {
  forkSessionActorStoredState,
  withSessionActorTransactionState,
} from "./session-actor-transaction.js";
import { sessionActorFileTarget } from "./session-actor-worker.test-support.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { mutatePendingInput, readPendingInput } from "./session-pending-input-operations.kernel.js";
import { readSessionTranscriptAnchorFactsInDatabase } from "./session-transcript-anchor-read.kernel.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import { applySessionTurn } from "./session-turn.worker.js";

// mock-isolation: Session storage proof does not schedule unrelated background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Keep background disk-budget eviction out of the fixture's transaction proof.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

function kernelFixture() {
  const f = createSessionCompoundWorkerFixture();
  const { database } = f;
  const options = { agentId: database.agentId, path: database.path };
  const target = sessionActorFileTarget(database, f.scope.sessionKey);
  const write = <T>(run: () => T) => runOpenClawAgentWriteTransaction(run, options);
  return {
    ...f,
    options,
    target,
    write,
    inState: <T>(state: SessionActorStoredState, run: () => T) => {
      return write(() => withSessionActorTransactionState(database, state, run));
    },
    hydrate: () => {
      return hydrateSessionActorState(database, target, { epoch: "window", sequence: 0 }, "");
    },
  };
}

function expectReload(result: ReturnType<typeof applySessionActorAppend>, snapshot: object) {
  expect(result).toMatchObject({
    kind: "metadata",
    value: { reload: { ok: true, value: { kind: "bounded", snapshot } } },
  });
}

it("hydrates once and commits, rejects, and rolls back against the exact actor preimage", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = kernelFixture();
    const { database, options, target } = f;
    const scope = { ...f.scope, path: database.path };
    runOpenClawAgentWriteTransaction((db) => {
      appendTranscriptEventsInTransaction(db, scope, [
        {
          type: "session",
          id: "original",
          version: 3,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/synthetic",
        },
        {
          type: "message",
          id: "user",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "hello", idempotencyKey: "first-user" },
        },
      ]);
    }, options);
    const expected = readPendingInput(database, {
      kind: "stage",
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      idempotencyKey: "accepted-user",
      trackCompletion: true,
    });
    assert(expected.kind === "stage", "Expected pending-input stage facts");
    const pending = {
      kind: "stage" as const,
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      idempotencyKey: "accepted-user",
      inputId: "accepted-input",
      runId: "run",
      requestHash: "hash",
      lifecycleGeneration: "lifecycle",
      trackCompletion: true,
      messageJson: JSON.stringify({
        role: "user",
        content: "accepted",
        idempotencyKey: "accepted-user",
      }),
      expected,
    };
    const cachedEntries = () =>
      readSessionEntryCache(database, { projection: "list", cache: true });
    expect(cachedEntries().entries.get(scope.sessionKey)?.label).toBe("initial");
    const reads: string[] = [];
    const counter = trackSqliteStatementExecutions(database.db, ["reads"], (query) => {
      if (!/^select\b/i.test(query)) {
        return null;
      }
      reads.push(query);
      return "reads";
    });
    let state: SessionActorStoredState;
    try {
      state = hydrateSessionActorState(database, target, { epoch: "test", sequence: 0 }, "initial");
      expect(counter.counts.reads).toBe(1);
      expect(state.hot.transcript.modelContext).toEqual({
        kind: "unavailable",
        reason: "projection",
        generation: state.hot.transcript.version.generation,
      });
      expect(state.hot.transcript.idempotency).toEqual([]);
      expect(state.hot.completionKeys).toEqual([]);
      counter.counts.reads = 0;
      reads.length = 0;
      const beforeCommit = structuredClone(state);
      const working = forkSessionActorStoredState(state);
      runOpenClawAgentWriteTransaction(
        (db) =>
          withSessionActorTransactionState(db, working, () => {
            const context = {
              open: () => db,
              options,
              admit: () => {},
              writeTransaction: <T>(
                _label: string,
                _owner: string,
                run: (current: typeof db) => T,
              ) => run(db),
            };
            mutatePendingInput(pending, context, () => {});
            writeSessionEntry(db, scope.sessionKey, {
              ...working.hot.entry!,
              activeWriterRunId: "run",
              updatedAt: 2,
              label: "actor committed",
            });
            const result = applySessionTurn(
              {
                agentId: "main",
                sessionKey: scope.sessionKey,
                options: {
                  expectedSessionId: scope.sessionId,
                  expectedWriterRunId: "run",
                  sessionFile: "synthetic.jsonl",
                  messages: [
                    {
                      eventId: "assistant",
                      message: {
                        role: "assistant",
                        content: "answer",
                        idempotencyKey: "assistant-once",
                      },
                    },
                  ],
                  touchSessionEntry: true,
                },
              },
              context,
              (_database, candidate) => candidate,
            );
            expect(result.result.appendedMessages).toMatchObject([
              { appended: true, messageId: "assistant", effectiveParentId: "user" },
            ]);
            expect(result.result.sessionEntry).toMatchObject({ activeWriterRunId: "run" });
            expect(readSessionPendingInputByKey(db, scope, pending.idempotencyKey)?.input_id).toBe(
              "accepted-input",
            );
          }),
        options,
      );
      expect(counter.counts.reads, reads.join("\n")).toBe(0);
      const postimage = projectSessionActorHotState(working);
      expect(postimage.pendingInputs).toMatchObject([
        { input_id: "accepted-input", state: "queued" },
      ]);
      expect(postimage.transcript.anchorsState).toBe("unavailable");
      expect(postimage.transcript.anchors).toEqual([]);
      expect(postimage.transcript.modelContext).toEqual({
        kind: "unavailable",
        reason: "projection",
        generation: postimage.transcript.version.generation,
      });
      expect(state).toEqual(beforeCommit);
      state = working;
    } finally {
      counter.restore();
    }
    expect(
      readSessionTranscriptAnchorFactsInDatabase(database, scope, {
        entryIds: ["user", "assistant"],
      }).anchors,
    ).toMatchObject([
      { entryId: "user", idempotencyKey: "first-user" },
      { entryId: "assistant", effectiveParentId: "user", idempotencyKey: "assistant-once" },
    ]);
    expect(
      readSessionTranscriptBoundedActiveContextCore(scope, { maxBytes: 10_000, maxEvents: 20 })
        .events,
    ).toMatchObject([{ type: "session" }, { id: "user" }, { id: "assistant" }]);
    expect(cachedEntries().entries.get(scope.sessionKey)?.label).toBe("actor committed");
    const committed = projectSessionActorHotState(state);
    const projectionState = {
      ...state,
      hot: {
        ...state.hot,
        entry: {
          ...state.hot.entry!,
          cliSessionIds: { synthetic: "original-session" },
        },
        participants: [
          {
            identity: { type: "profile" as const, id: "owner" },
            contributionCount: 1,
            firstPromptedAt: 1,
            lastPromptedAt: 2,
          },
        ],
        members: [{ identityId: "owner", addedBy: "owner", addedAt: 1 }],
      },
    };
    const retained = structuredClone(projectionState);
    const detached = projectSessionActorHotState(projectionState);
    const original = structuredClone(detached);
    detached.entry!.label = "caller edit";
    detached.entry!.cliSessionIds!.synthetic = "caller edit";
    Object.assign(detached.target.database, { birthtime: "caller edit" });
    Object.assign(detached.version, { sequence: -1 });
    detached.participants[0]!.identity.id = "caller edit";
    detached.members[0]!.identityId = "caller edit";
    detached.pendingInputs[0]!.input_id = "caller edit";
    detached.transcript.version.rawSeq = -1;
    detached.transcript.watermark.maxSeq = -1;
    expect(projectionState).toEqual(retained);
    expect(projectSessionActorHotState(projectionState)).toEqual(original);
    const beforeRollback = structuredClone(state);
    const abandoned = forkSessionActorStoredState(state);
    expect(() =>
      runOpenClawAgentWriteTransaction(
        (db) =>
          withSessionActorTransactionState(db, abandoned, () => {
            writeSessionEntry(db, scope.sessionKey, {
              ...abandoned.hot.entry!,
              label: "rolled back",
            });
            appendTranscriptEventsInTransaction(db, scope, [
              {
                type: "message",
                id: "rolled-back-message",
                parentId: "assistant",
                timestamp: "2026-01-01T00:00:03.000Z",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "rolled back" }],
                  idempotencyKey: "rolled-back-once",
                },
              },
            ]);
            mutatePendingInput(
              {
                ...pending,
                kind: "complete",
                outcome: buildAgentRunTerminalOutcome({ status: "ok" }),
              },
              {
                admit: (stage) => {
                  if (stage === "commit") {
                    throw new Error("authority revoked");
                  }
                },
                writeTransaction: (_label, _owner, run) => run(db),
              },
              () => {},
            );
          }),
        options,
      ),
    ).toThrow("authority revoked");
    expect(state).toEqual(beforeRollback);
    expect(projectSessionActorHotState(state)).toEqual(committed);
    expect(readSessionInputCompletion(database, pending)).toBeUndefined();
    expect(readSessionPendingInputByKey(database, scope, pending.idempotencyKey)?.input_id).toBe(
      "accepted-input",
    );
    const completed = forkSessionActorStoredState(state);
    runOpenClawAgentWriteTransaction(
      (db) =>
        withSessionActorTransactionState(db, completed, () => {
          mutatePendingInput(
            {
              ...pending,
              kind: "complete",
              outcome: buildAgentRunTerminalOutcome({ status: "ok" }),
            },
            {
              admit() {},
              writeTransaction: (_label, _owner, run) => run(db),
            },
            () => {},
          );
        }),
      options,
    );
    const completedPostimage = projectSessionActorHotState(completed);
    expect(completedPostimage.pendingInputs).toEqual([]);
    expect(completedPostimage.completionKeys).toEqual([]);
    expect(readSessionInputCompletion(database, pending)).toBeDefined();
    const rehydrated = hydrateSessionActorState(
      database,
      target,
      state.hot.version,
      state.hot.writeToken,
    );
    expect(projectSessionActorHotState(rehydrated)).toEqual(completedPostimage);
  });
});

it("initializes over a retained transcript and preserves prepared snapshots, reloads, replay, and fresh authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = kernelFixture();
    const { database, options, target, scope, inState } = f;
    runOpenClawAgentWriteTransaction((db) => {
      appendTranscriptEventsInTransaction(db, { ...scope, path: database.path }, [
        {
          type: "session",
          id: scope.sessionId,
          version: 3,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/synthetic",
        },
        {
          type: "message",
          id: "retained-user",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "retained" },
        },
      ]);
      db.db
        .prepare(`UPDATE transcript_events
        SET navigation_type = NULL, navigation_custom_type = NULL,
            navigation_display = 0, message_role = NULL, navigation_last_type = NULL,
            navigation_last_custom_type = NULL, navigation_valid = 1
        WHERE session_id = ?`)
        .run(scope.sessionId);
      deleteSessionEntryRows(db, scope.sessionKey);
    }, options);
    expect(f.events()).toHaveLength(2);
    const state = hydrateSessionActorState(
      database,
      target,
      { epoch: "initial", sequence: 0 },
      "initial",
    );
    expect(state.hot.entry).toBeUndefined();
    expect(state.transcript.navigation).toHaveLength(2);
    let rejectFresh = false;
    let freshChecks = 0;
    const context = {
      open: () => database,
      options,
      writeTransaction: <T>(
        _label: string,
        _owner: string,
        write: (current: typeof database) => T,
      ) => write(database),
      admit: (_stage: "transaction" | "commit", facts?: unknown) => {
        if (
          facts &&
          typeof facts === "object" &&
          "kind" in facts &&
          facts.kind === "session-message" &&
          "check" in facts &&
          facts.check === "fresh"
        ) {
          freshChecks += 1;
          if (rejectFresh) {
            throw new Error("fresh authority revoked");
          }
        }
      },
    };
    const append: SessionActorAppend = {
      kind: "metadata",
      input: {
        scope,
        event: {
          type: "message",
          id: "prepared-assistant",
          parentId: "retained-user",
          timestamp: "2026-01-01T00:00:02.000Z",
        },
        message: {
          messageJson: JSON.stringify({
            role: "assistant",
            content: "prepared bytes",
            idempotencyKey: "prepared-once",
          }),
          cwd: "/synthetic",
          validateTurn: true,
          freshMessageCheck: true,
        },
        options: {},
        view: {
          loadedVersion: { generation: null, rawSeq: null, updatedAt: null },
          limits: { maxBytes: 10_000, maxEvents: 20 },
        },
      },
      initialization: {
        scope,
        entry: { sessionId: scope.sessionId, updatedAt: 3 },
        initialWriterRunId: "first-run",
      },
    };
    const execute = (input: SessionActorAppend, working = state) =>
      inState(working, () => applySessionActorAppend(input, working, context));
    const retainedReads = trackSqliteStatementExecutions(
      database.db,
      ["entry", "newer", "parents", "projection"],
      (query) =>
        query.toLowerCase().includes('from "session_nodes"')
          ? "entry"
          : query.includes('"serialized_bytes"') && query.includes('"identity"."seq" >')
            ? "newer"
            : query.includes('"parent"."event_id" as "parent_id"')
              ? "parents"
              : query.includes('"reset_active_position"')
                ? "projection"
                : null,
    );
    const committed = (() => {
      try {
        return execute(append);
      } finally {
        retainedReads.restore();
      }
    })();
    expect(retainedReads.counts).toEqual({ entry: 0, newer: 0, parents: 0, projection: 0 });
    initializeSessionActorContextStats(database, state);
    expect(committed.kind).toBe("metadata");
    assert(committed.kind === "metadata", "Expected prepared metadata append");
    expect(committed.initialEntry).toMatchObject({
      owned: true,
      fence: { expectedWriterRunId: "first-run" },
    });
    expect(committed.value.snapshot).toMatchObject({
      ok: true,
      value: {
        before: { rawSeq: 1 },
        after: { rawSeq: 2 },
        result: {
          appended: true,
          messageId: "prepared-assistant",
          effectiveParentId: "retained-user",
          message: undefined,
        },
      },
    });
    expectReload(committed, {
      version: { rawSeq: 2 },
      events: [{ id: scope.sessionId }, { id: "retained-user" }, { id: "prepared-assistant" }],
      parents: new Map([
        ["retained-user", null],
        ["prepared-assistant", "retained-user"],
      ]),
    });
    expect(freshChecks).toBe(1);
    expect(f.events()).toHaveLength(3);
    const replay = execute({ kind: "metadata", input: append.input });
    expect(replay.value.snapshot).toMatchObject({
      ok: true,
      value: {
        result: {
          appended: false,
          messageId: "prepared-assistant",
          message: { content: "prepared bytes" },
        },
      },
    });
    expect(freshChecks).toBe(1);
    rejectFresh = true;
    const abandoned = forkSessionActorStoredState(state);
    expect(() =>
      execute(
        {
          kind: "metadata",
          input: {
            ...append.input,
            event: {
              type: "message",
              timestamp: "2026-01-01T00:00:03.000Z",
              id: "refused",
              parentId: "prepared-assistant",
            },
            message: {
              ...append.input.message!,
              messageJson: JSON.stringify({
                role: "assistant",
                content: "must not persist",
                idempotencyKey: "refused",
              }),
            },
          },
        },
        abandoned,
      ),
    ).toThrow("fresh authority revoked");
    const directAbandoned = forkSessionActorStoredState(state);
    expect(() =>
      execute(
        {
          kind: "message",
          input: {
            scope,
            cwd: "/synthetic",
            freshMessageCheck: true,
            messageJson: JSON.stringify({
              role: "assistant",
              content: "direct append must check fresh authority",
              idempotencyKey: "direct-refused",
            }),
          },
        },
        directAbandoned,
      ),
    ).toThrow("fresh authority revoked");
    expect(freshChecks).toBe(3);
    expect(f.events()).toHaveLength(3);
    expect(
      projectSessionActorHotState(
        hydrateSessionActorState(database, target, state.hot.version, state.hot.writeToken),
      ),
    ).toEqual(projectSessionActorHotState(state));
    rejectFresh = false;
    const advanced = execute({
      kind: "metadata",
      input: {
        ...append.input,
        event: {
          type: "message",
          id: "newer-user",
          parentId: "prepared-assistant",
          timestamp: "2026-01-01T00:00:04.000Z",
        },
        message: {
          ...append.input.message!,
          messageJson: JSON.stringify({ role: "user", content: "a different turn" }),
          validateTurn: false,
        },
      },
    });
    expectReload(advanced, {
      parents: new Map([
        ["retained-user", null],
        ["prepared-assistant", "retained-user"],
        ["newer-user", "prepared-assistant"],
      ]),
    });
    expect(() =>
      execute({
        kind: "metadata",
        input: {
          ...append.input,
          event: {
            type: "message",
            id: "stale-assistant",
            parentId: "prepared-assistant",
            timestamp: "2026-01-01T00:00:05.000Z",
          },
        },
      }),
    ).toThrow("changed");
    expect(f.events().at(-1)).toMatchObject({ id: "newer-user" });
    const reset = execute({
      kind: "metadata",
      input: {
        ...append.input,
        event: JSON.stringify({
          type: "reset",
          id: "reset",
          parentId: "newer-user",
          timestamp: "2026-01-01T00:00:06.000Z",
          reason: "new",
        }),
        message: undefined,
        view: { ...append.input.view!, limits: { maxBytes: 10_000, maxEvents: 1 } },
      },
    });
    expectReload(reset, {
      events: [{ id: scope.sessionId }, { id: "reset" }],
      parents: new Map([["reset", "newer-user"]]),
    });
  });
});

it("bounds completion residency while preserving old retries, committed writes, and rollback", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = kernelFixture();
    const { database } = f;
    const { write, inState } = f;
    const scope = (idempotencyKey: string) => ({
      ...f.scope,
      idempotencyKey,
      runId: `run-${idempotencyKey}`,
      requestHash: `hash-${idempotencyKey}`,
      lifecycleGeneration: "synthetic",
    });
    const success = buildAgentRunTerminalOutcome({ status: "ok" });
    const interrupted = buildAgentRunTerminalOutcome({ status: "timeout", stopReason: "restart" });
    write(() => {
      ensureSessionPendingInputsSchema(database.db);
      ensureSessionInputCompletionsSchema(database.db);
      for (let index = 0; index < 512; index += 1) {
        writeSessionInputCompletion(
          database,
          scope(`receipt-${String(index).padStart(3, "0")}`),
          index === 0 ? interrupted : success,
        );
      }
    });
    const resident = f.hydrate();
    const newScope = scope("recent-completion");
    const complete = (state: SessionActorStoredState) =>
      withSessionActorTransactionState(database, state, () => {
        expect(writeSessionInputCompletion(database, newScope, success)).toEqual(success);
        expect(readSessionInputCompletion(database, newScope)?.outcome).toEqual(success);
      });
    expect(() =>
      write(() => {
        complete(forkSessionActorStoredState(resident));
        throw new Error("synthetic rollback");
      }),
    ).toThrow("synthetic rollback");
    inState(resident, () => {
      expect(readSessionInputCompletion(database, newScope)).toBeUndefined();
      expect(readSessionInputCompletion(database, scope("receipt-000"))?.outcome).toEqual(
        interrupted,
      );
    });
    expect(readSessionInputCompletion(database, newScope)).toBeUndefined();

    const committed = forkSessionActorStoredState(resident);
    write(() => complete(committed));
    expect(committed.completions.size).toBeLessThanOrEqual(512);
    inState(committed, () => {
      expect(writeSessionInputCompletion(database, scope("receipt-000"), success)).toEqual(success);
      expect(readSessionInputCompletion(database, scope("receipt-000"))?.outcome).toEqual(success);
      expect(writeSessionInputCompletion(database, scope("receipt-001"), interrupted)).toEqual(
        success,
      );
      expect(() =>
        writeSessionInputCompletion(
          database,
          { ...scope("receipt-001"), requestHash: "conflicting-input" },
          success,
        ),
      ).toThrow("Input completion conflicts with the accepted input");
    });
    const rehydrated = f.hydrate();
    expect(rehydrated.completions.size).toBeLessThanOrEqual(512);
    inState(rehydrated, () => {
      expect(readSessionInputCompletion(database, newScope)?.outcome).toEqual(success);
      expect(readSessionInputCompletion(database, scope("receipt-000"))?.outcome).toEqual(success);
    });
  });
});

it("preserves historical replay and branch ancestry outside the actor's retained window", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = kernelFixture();
    const { database } = f;
    const scope = { ...f.scope, path: database.path };
    const { write, inState } = f;
    const originalMessage = { role: "user", content: "first", idempotencyKey: "first-once" };
    write(() => {
      appendTranscriptEventsInTransaction(
        database,
        scope,
        [
          { type: "session", id: scope.sessionId, version: 3, cwd: "/synthetic" },
          { type: "message", id: "first", parentId: null, message: originalMessage },
          {
            type: "message",
            id: "answer",
            parentId: "first",
            message: { role: "assistant", content: "answer" },
          },
          {
            type: "message",
            id: "second",
            parentId: "answer",
            message: { role: "user", content: "second" },
          },
          ...Array.from({ length: 520 }, (_, index) => ({
            type: "custom",
            id: `side-${index}`,
            parentId: index === 0 ? "second" : `side-${index - 1}`,
            appendMode: "side",
            data: { synthetic: true },
          })),
        ],
        { scheduleProjectionReconcile: false },
      );
      reconcileSessionTranscriptIndexInTransaction(database.db, scope.sessionId);
    });
    const state = f.hydrate();
    expect(state.transcript.complete).toBe(false);
    expect(state.transcript.identities.has("first")).toBe(false);
    inState(state, () => {
      expect(
        resolveTranscriptMessageAppendParent(database, scope.sessionId, {
          appendIntent: "active-branch",
          parentId: "first",
        }),
      ).toBe("side-519");
      expect(
        readTranscriptVisibleTailEntryIdInTransaction(database, scope.sessionId, "first"),
      ).toBe("second");
      expect(isTranscriptEntryOnActivePathInTransaction(database, scope.sessionId, "first")).toBe(
        true,
      );
      expect(canRebasePreparedAssistantInTransaction(database, scope.sessionId, "first")).toBe(
        false,
      );
      expect(canRebasePreparedAssistantInTransaction(database, scope.sessionId, "second")).toBe(
        true,
      );
      expect(
        appendTranscriptMessageInTransaction(database, scope, {
          message: originalMessage,
          eventId: "must-not-append",
        })?.result,
      ).toMatchObject({
        appended: false,
        messageId: "first",
        message: originalMessage,
        anchor: { entryId: "first", effectiveParentId: null },
      });

      appendTranscriptEventsInTransaction(database, scope, [
        {
          type: "leaf",
          id: "historical-branch",
          parentId: "side-519",
          targetId: "first",
          appendParentId: "answer",
        },
      ]);
      expect(resolveTranscriptMessageAppendParent(database, scope.sessionId, {})).toBe("answer");
      expect(
        readTranscriptVisibleTailEntryIdInTransaction(database, scope.sessionId, "first"),
      ).toBe("first");
      expect(
        appendTranscriptMessageInTransaction(database, scope, {
          message: {
            role: "assistant",
            content: "continued branch",
            idempotencyKey: "next-once",
          },
          eventId: "next",
        })?.result,
      ).toMatchObject({ appended: true, messageId: "next", effectiveParentId: "answer" });
      expect(resolveTranscriptMessageAppendParent(database, scope.sessionId, {})).toBe("next");
      expect(
        appendTranscriptMessageInTransaction(database, scope, {
          message: {
            role: "assistant",
            content: "continued branch",
            idempotencyKey: "next-once",
          },
          eventId: "also-must-not-append",
        })?.result,
      ).toMatchObject({ appended: false, messageId: "next" });
    });
    const events = f.events();
    expect(events).toHaveLength(526);
    expect(events.at(-1)).toMatchObject({ id: "next", parentId: "answer" });
  });
});

it("keeps partial actor appends after a reset when a leaf targets older history", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = kernelFixture();
    const { database } = f;
    const scope = { ...f.scope, path: database.path };
    const { write, inState } = f;
    write(() => {
      appendTranscriptEventsInTransaction(
        database,
        scope,
        [
          { type: "session", id: scope.sessionId, version: 3, cwd: "/synthetic" },
          {
            type: "message",
            id: "before-reset",
            parentId: null,
            message: { role: "user", content: "old question" },
          },
          { type: "reset", id: "reset", parentId: "before-reset" },
          {
            type: "message",
            id: "after-reset",
            parentId: "reset",
            message: { role: "user", content: "current question" },
          },
          ...Array.from({ length: 520 }, (_, index) => ({
            type: "custom",
            id: `side-${index}`,
            parentId: index === 0 ? "after-reset" : `side-${index - 1}`,
            appendMode: "side",
          })),
          {
            type: "leaf",
            id: "stale-leaf",
            parentId: "side-519",
            targetId: "before-reset",
          },
        ],
        { scheduleProjectionReconcile: false },
      );
      reconcileSessionTranscriptIndexInTransaction(database.db, scope.sessionId);
    });
    const state = f.hydrate();
    expect(state.transcript.complete).toBe(false);
    inState(state, () => {
      expect(resolveTranscriptMessageAppendParent(database, scope.sessionId, {})).toBe(
        "after-reset",
      );
      expect(
        appendTranscriptMessageInTransaction(database, scope, {
          eventId: "continued",
          message: { role: "assistant", content: "current answer" },
        })?.result,
      ).toMatchObject({ appended: true, effectiveParentId: "after-reset" });
    });
    expect(f.events().at(-1)).toMatchObject({ id: "continued", parentId: "after-reset" });
  });
});

it("bounds committed actor growth across the window limit without retaining rolled-back events", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = kernelFixture();
    const { database } = f;
    const scope = { ...f.scope, path: database.path };
    const { write, inState } = f;
    const originalMessage = { role: "assistant", content: "first", idempotencyKey: "first-once" };
    write(() =>
      appendTranscriptEventsInTransaction(database, scope, [
        { type: "session", id: scope.sessionId, version: 3, cwd: "/synthetic" },
        ...Array.from({ length: 511 }, (_, index) => ({
          type: "message",
          id: `message-${index}`,
          parentId: index === 0 ? null : `message-${index - 1}`,
          message: index === 0 ? originalMessage : { role: "assistant", content: "synthetic" },
        })),
      ]),
    );
    const resident = f.hydrate();
    expect(resident.transcript.complete).toBe(true);
    const residency = createSessionActorResidency();
    residency.remember(resident);
    const append = (state: SessionActorStoredState) =>
      withSessionActorTransactionState(database, state, () => {
        for (const eventId of ["next-one", "next-two"]) {
          expect(
            appendTranscriptMessageInTransaction(database, scope, {
              eventId,
              message: { role: "assistant", content: eventId },
            })?.result.appended,
          ).toBe(true);
        }
      });
    expect(() =>
      write(() => {
        append(forkSessionActorStoredState(resident));
        throw new Error("synthetic rollback");
      }),
    ).toThrow("synthetic rollback");
    expect(residency.get(scope.sessionKey)).toBe(resident);
    expect(resident.transcript.complete).toBe(true);
    expect(resident.transcript.navigation).toHaveLength(512);
    expect(resident.transcript.identities.has("next-one")).toBe(false);
    expect(f.events()).toHaveLength(512);

    const committed = forkSessionActorStoredState(resident);
    write(() => append(committed));
    residency.remember(committed);
    expect(committed.transcript.complete).toBe(false);
    expect(committed.transcript.navigation).toHaveLength(512);
    expect(committed.transcript.identities.size).toBeLessThanOrEqual(512);
    expect(committed.transcript.active.size).toBeLessThanOrEqual(512);
    expect(committed.transcript.identities.has("message-0")).toBe(false);
    inState(committed, () => {
      expect(
        appendTranscriptMessageInTransaction(database, scope, {
          eventId: "must-not-append",
          message: originalMessage,
        })?.result,
      ).toMatchObject({ appended: false, messageId: "message-0" });
    });
    expect(f.events()).toHaveLength(514);
    residency.clear();
  });
});
