import { assert, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
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
import { timedMessageEvent, messageEvent } from "./transcript-message.test-support.js";

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
  const scope = { ...f.scope, path: database.path };
  const target = sessionActorFileTarget(database, f.scope.sessionKey);
  const write = <T>(run: () => T) => runOpenClawAgentWriteTransaction(run, options);
  const writeContext = (
    admit: AgentWorkerOperationContext["admit"] = () => {},
  ): Pick<AgentWorkerOperationContext, "admit" | "writeTransaction"> => ({
    admit,
    writeTransaction: (_label, _owner, run) => run(database),
  });
  const context = (admit?: AgentWorkerOperationContext["admit"]): AgentWorkerOperationContext => ({
    ...writeContext(admit),
    open: () => database,
    options,
  });
  return {
    ...f,
    options,
    target,
    write,
    writeContext,
    context,
    transcriptScope: scope,
    append: <T>(eventId: string, message: T) =>
      appendTranscriptMessageInTransaction(database, scope, { eventId, message })?.result,
    seedWindow: (events: Parameters<typeof appendTranscriptEventsInTransaction>[2]) =>
      write(() => {
        appendTranscriptEventsInTransaction(database, scope, events, {
          scheduleProjectionReconcile: false,
        });
        reconcileSessionTranscriptIndexInTransaction(database.db, scope.sessionId);
      }),
    parent: (request: Parameters<typeof resolveTranscriptMessageAppendParent>[2] = {}) =>
      resolveTranscriptMessageAppendParent(database, scope.sessionId, request),
    visibleTail: (id: string) =>
      readTranscriptVisibleTailEntryIdInTransaction(database, scope.sessionId, id),
    onActivePath: (id: string) =>
      isTranscriptEntryOnActivePathInTransaction(database, scope.sessionId, id),
    canRebase: (id: string) =>
      canRebasePreparedAssistantInTransaction(database, scope.sessionId, id),
    inState: <T>(state: SessionActorStoredState, run: () => T) =>
      write(() => withSessionActorTransactionState(database, state, run)),
    hydrate: () => hydrateSessionActorState(database, target, { epoch: "window", sequence: 0 }, ""),
  };
}

const withKernel = (run: (fixture: ReturnType<typeof kernelFixture>) => void | Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => await run(kernelFixture()));

const header = (id: string) => ({
  type: "session",
  id,
  version: 3,
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/synthetic",
});
const sideEvents = (parent: string, data?: object) =>
  Array.from({ length: 520 }, (_, index) => ({
    type: "custom",
    id: `side-${index}`,
    parentId: index === 0 ? parent : `side-${index - 1}`,
    appendMode: "side",
    ...(data ? { data } : {}),
  }));
const user = (content: string, idempotencyKey?: string) => ({
  role: "user",
  content,
  ...(idempotencyKey ? { idempotencyKey } : {}),
});
const assistant = (content: string, idempotencyKey?: string) => ({
  role: "assistant",
  content,
  ...(idempotencyKey ? { idempotencyKey } : {}),
});
const messageEnvelope = (id: string, parentId: string, second: number) => ({
  type: "message" as const,
  id,
  parentId,
  timestamp: `2026-01-01T00:00:0${second}.000Z`,
});

function expectReload(result: ReturnType<typeof applySessionActorAppend>, snapshot: object) {
  expect(result).toMatchObject({
    kind: "metadata",
    value: { reload: { ok: true, value: { kind: "bounded", snapshot } } },
  });
}

it("hydrates once and commits, rejects, and rolls back against the exact actor preimage", () =>
  withKernel((f) => {
    const { database, target, write, inState, context, writeContext } = f;
    const scope = { ...f.scope, path: database.path };
    write(() => {
      appendTranscriptEventsInTransaction(database, scope, [
        header("original"),
        timedMessageEvent("user", null, "2026-01-01T00:00:01.000Z", user("hello", "first-user")),
      ]);
    });
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
      messageJson: JSON.stringify(user("accepted", "accepted-user")),
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
      counter.counts.reads = 0;
      reads.length = 0;
      const beforeCommit = structuredClone(state);
      const working = forkSessionActorStoredState(state);
      inState(working, () => {
        const operationContext = context();
        mutatePendingInput(pending, operationContext, () => {});
        writeSessionEntry(database, scope.sessionKey, {
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
                  message: assistant("answer", "assistant-once"),
                },
              ],
              touchSessionEntry: true,
            },
          },
          operationContext,
          (_database, candidate) => candidate,
        );
        expect(result.result.appendedMessages).toMatchObject([
          { appended: true, messageId: "assistant", effectiveParentId: "user" },
        ]);
        expect(result.result.sessionEntry).toMatchObject({ activeWriterRunId: "run" });
        expect(
          readSessionPendingInputByKey(database, scope, pending.idempotencyKey)?.input_id,
        ).toBe("accepted-input");
      });
      expect(counter.counts.reads, reads.join("\n")).toBe(0);
      const postimage = projectSessionActorHotState(working);
      expect(postimage.pendingInputs).toMatchObject([
        { input_id: "accepted-input", state: "queued" },
      ]);
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
    const retained = structuredClone(state);
    const detached = projectSessionActorHotState(state);
    const original = structuredClone(detached);
    // Internal projections retain replace-only metadata; publication owns detachment.
    expect(detached.target).toBe(state.hot.target);
    expect(detached.version).toBe(state.hot.version);
    expect(detached.participants).toBe(state.hot.participants);
    expect(detached.members).toBe(state.hot.members);
    detached.pendingInputs[0]!.input_id = "caller edit";
    detached.transcript.version.rawSeq = -1;
    detached.transcript.watermark.maxSeq = -1;
    expect(state).toEqual(retained);
    expect(projectSessionActorHotState(state)).toEqual(original);
    const abandoned = forkSessionActorStoredState(state);
    expect(() =>
      inState(abandoned, () => {
        writeSessionEntry(database, scope.sessionKey, {
          ...abandoned.hot.entry!,
          label: "rolled back",
        });
        appendTranscriptEventsInTransaction(database, scope, [
          timedMessageEvent("rolled-back-message", "assistant", "2026-01-01T00:00:03.000Z", {
            role: "assistant",
            content: [{ type: "text", text: "rolled back" }],
            idempotencyKey: "rolled-back-once",
          }),
        ]);
        mutatePendingInput(
          {
            ...pending,
            kind: "complete",
            outcome: buildAgentRunTerminalOutcome({ status: "ok" }),
          },
          writeContext((stage) => {
            if (stage === "commit") {
              throw new Error("authority revoked");
            }
          }),
          () => {},
        );
      }),
    ).toThrow("authority revoked");
    expect(state).toEqual(retained);
    expect(readSessionInputCompletion(database, pending)).toBeUndefined();
    expect(readSessionPendingInputByKey(database, scope, pending.idempotencyKey)?.input_id).toBe(
      "accepted-input",
    );
    const completed = forkSessionActorStoredState(state);
    inState(completed, () => {
      mutatePendingInput(
        {
          ...pending,
          kind: "complete",
          outcome: buildAgentRunTerminalOutcome({ status: "ok" }),
        },
        writeContext(),
        () => {},
      );
    });
    const completedPostimage = projectSessionActorHotState(completed);
    expect(completedPostimage.pendingInputs).toEqual([]);
    expect(readSessionInputCompletion(database, pending)).toBeDefined();
    const rehydrated = hydrateSessionActorState(
      database,
      target,
      state.hot.version,
      state.hot.writeToken,
    );
    expect(projectSessionActorHotState(rehydrated)).toEqual(completedPostimage);
  }));

it("initializes over a retained transcript and preserves prepared snapshots, reloads, replay, and fresh authority", () =>
  withKernel((f) => {
    const { database, target, scope, inState, write } = f;
    write(() => {
      appendTranscriptEventsInTransaction(database, { ...scope, path: database.path }, [
        header(scope.sessionId),
        timedMessageEvent("retained-user", null, "2026-01-01T00:00:01.000Z", user("retained")),
      ]);
      database.db
        .prepare(`UPDATE transcript_events
        SET navigation_type = NULL, navigation_custom_type = NULL,
            navigation_display = 0, message_role = NULL, navigation_last_type = NULL,
            navigation_last_custom_type = NULL, navigation_valid = 1
        WHERE session_id = ?`)
        .run(scope.sessionId);
      deleteSessionEntryRows(database, scope.sessionKey);
    });
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
    const context = f.context((_stage, facts) => {
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
    });
    const append: Extract<SessionActorAppend, { kind: "metadata" }> = {
      kind: "metadata",
      input: {
        scope,
        event: messageEnvelope("prepared-assistant", "retained-user", 2),
        message: {
          messageJson: JSON.stringify(assistant("prepared bytes", "prepared-once")),
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
    const metadata = (
      event: typeof append.input.event,
      message: typeof append.input.message = append.input.message,
    ): SessionActorAppend => ({ kind: "metadata", input: { ...append.input, event, message } });
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
        metadata(messageEnvelope("refused", "prepared-assistant", 3), {
          ...append.input.message!,
          messageJson: JSON.stringify(assistant("must not persist", "refused")),
        }),
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
            messageJson: JSON.stringify(
              assistant("direct append must check fresh authority", "direct-refused"),
            ),
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
    const advanced = execute(
      metadata(messageEnvelope("newer-user", "prepared-assistant", 4), {
        ...append.input.message!,
        messageJson: JSON.stringify(user("a different turn")),
        validateTurn: false,
      }),
    );
    expectReload(advanced, {
      parents: new Map([
        ["retained-user", null],
        ["prepared-assistant", "retained-user"],
        ["newer-user", "prepared-assistant"],
      ]),
    });
    expect(() =>
      execute(metadata(messageEnvelope("stale-assistant", "prepared-assistant", 5))),
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
  }));

it("bounds completion residency while preserving old retries, committed writes, and rollback", () =>
  withKernel((f) => {
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
  }));

it("preserves historical replay and branch ancestry outside the actor's retained window", () =>
  withKernel((f) => {
    const { transcriptScope: scope, inState } = f;
    const originalMessage = user("first", "first-once");
    f.seedWindow([
      { type: "session", id: scope.sessionId, version: 3, cwd: "/synthetic" },
      { type: "message", id: "first", parentId: null, message: originalMessage },
      messageEvent("answer", "first", assistant("answer")),
      messageEvent("second", "answer", user("second")),
      ...sideEvents("second", { synthetic: true }),
    ]);
    const state = f.hydrate();
    expect(state.transcript.complete).toBe(false);
    expect(state.transcript.identities.has("first")).toBe(false);
    inState(state, () => {
      expect(f.parent({ appendIntent: "active-branch", parentId: "first" })).toBe("side-519");
      expect(f.visibleTail("first")).toBe("second");
      expect(f.onActivePath("first")).toBe(true);
      expect(f.canRebase("first")).toBe(false);
      expect(f.canRebase("second")).toBe(true);
      expect(f.append("must-not-append", originalMessage)).toMatchObject({
        appended: false,
        messageId: "first",
        message: originalMessage,
        anchor: { entryId: "first", effectiveParentId: null },
      });

      appendTranscriptEventsInTransaction(f.database, scope, [
        {
          type: "leaf",
          id: "historical-branch",
          parentId: "side-519",
          targetId: "first",
          appendParentId: "answer",
        },
      ]);
      expect(f.parent()).toBe("answer");
      expect(f.visibleTail("first")).toBe("first");
      expect(f.append("next", assistant("continued branch", "next-once"))).toMatchObject({
        appended: true,
        messageId: "next",
        effectiveParentId: "answer",
      });
      expect(f.parent()).toBe("next");
      expect(
        f.append("also-must-not-append", assistant("continued branch", "next-once")),
      ).toMatchObject({ appended: false, messageId: "next" });
    });
    const events = f.events();
    expect(events).toHaveLength(526);
    expect(events.at(-1)).toMatchObject({ id: "next", parentId: "answer" });
  }));

it("keeps partial actor appends after a reset when a leaf targets older history", () =>
  withKernel((f) => {
    f.seedWindow([
      { type: "session", id: f.scope.sessionId, version: 3, cwd: "/synthetic" },
      messageEvent("before-reset", null, user("old question")),
      { type: "reset", id: "reset", parentId: "before-reset" },
      messageEvent("after-reset", "reset", user("current question")),
      ...sideEvents("after-reset"),
      {
        type: "leaf",
        id: "stale-leaf",
        parentId: "side-519",
        targetId: "before-reset",
      },
    ]);
    const state = f.hydrate();
    expect(state.transcript.complete).toBe(false);
    f.inState(state, () => {
      expect(f.parent()).toBe("after-reset");
      expect(f.append("continued", assistant("current answer"))).toMatchObject({
        appended: true,
        effectiveParentId: "after-reset",
      });
    });
    expect(f.events().at(-1)).toMatchObject({ id: "continued", parentId: "after-reset" });
  }));

it("bounds committed actor growth across the window limit without retaining rolled-back events", () =>
  withKernel((f) => {
    const { database } = f;
    const scope = { ...f.scope, path: database.path };
    const { write, inState } = f;
    const originalMessage = assistant("first", "first-once");
    write(() =>
      appendTranscriptEventsInTransaction(database, scope, [
        { type: "session", id: scope.sessionId, version: 3, cwd: "/synthetic" },
        ...Array.from({ length: 511 }, (_, index) =>
          messageEvent(
            `message-${index}`,
            index === 0 ? null : `message-${index - 1}`,
            index === 0 ? originalMessage : assistant("synthetic"),
          ),
        ),
      ]),
    );
    const resident = f.hydrate();
    expect(resident.transcript.complete).toBe(true);
    const residency = createSessionActorResidency();
    residency.remember(resident);
    const append = (state: SessionActorStoredState) =>
      withSessionActorTransactionState(database, state, () => {
        for (const eventId of ["next-one", "next-two"]) {
          expect(f.append(eventId, assistant(eventId))?.appended).toBe(true);
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
    const { navigation, identities, active } = committed.transcript;
    residency.remember(committed);
    // Appending already detached these collections from the rollback preimage.
    expect(committed.transcript.navigation).toBe(navigation);
    expect(committed.transcript.identities).toBe(identities);
    expect(committed.transcript.active).toBe(active);
    expect(committed.transcript.complete).toBe(false);
    expect(committed.transcript.navigation).toHaveLength(512);
    expect(committed.transcript.navigation.at(0)?.seq).toBe(2);
    expect(committed.transcript.navigation.at(-1)?.seq).toBe(513);
    expect(committed.transcript.identities.size).toBe(512);
    expect(committed.transcript.active.size).toBe(512);
    expect(committed.transcript.identities.has("message-0")).toBe(false);
    expect(resident.transcript.navigation).toHaveLength(512);
    expect(resident.transcript.navigation.at(0)?.seq).toBe(0);
    expect(resident.transcript.identities.has("message-0")).toBe(true);
    expect(resident.transcript.identities.has("next-one")).toBe(false);
    expect(resident.transcript.active.size).toBe(511);
    inState(committed, () => {
      expect(f.append("must-not-append", originalMessage)).toMatchObject({
        appended: false,
        messageId: "message-0",
      });
    });
    expect(f.events()).toHaveLength(514);
    residency.clear();
  }));
