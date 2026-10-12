import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { withSqliteDatabaseWriteScope } from "../../infra/sqlite-database-admission.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import {
  deleteSessionEntryRows,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import {
  readSessionInputCompletion,
  readSessionPendingInputByKey,
} from "./session-accessor.sqlite-pending-inputs.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { applySessionActorAppend } from "./session-actor-append.worker.js";
import type { SessionActorAppend, SessionActorTarget } from "./session-actor-contract.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import * as hydration from "./session-actor-hydration.worker.js";
import {
  hydrateSessionActorState,
  projectSessionActorHotState,
} from "./session-actor-hydration.worker.js";
import {
  cloneSessionActorStoredState,
  withSessionActorTransactionState,
} from "./session-actor-transaction.js";
import { withActor } from "./session-actor-worker.test-support.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { mutatePendingInput, readPendingInput } from "./session-pending-input-operations.kernel.js";
import { applySessionTurn } from "./session-turn.worker.js";

// mock-isolation: Session storage proof does not schedule unrelated background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Keep background disk-budget eviction out of the fixture's transaction proof.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

it.each([
  { kind: "unrelated", writes: 1 },
  { kind: "related", writes: 1 },
  { kind: "unscoped", writes: 1 },
  { kind: "unrelated", writes: 2 },
  { kind: "related", writes: 2 },
  { kind: "unscoped", writes: 2 },
] as const)("bounds hydration recovery after $writes $kind writes", async ({ kind, writes }) => {
  await withActor((f) => {
    const otherKey = "agent:main:hydration-sibling";
    const write = (key: string, label: string) =>
      withSqliteDatabaseWriteScope(f.database.db, [key], () =>
        runSqliteImmediateTransactionSync(f.database.db, () =>
          writeSessionEntry(f.database, key, {
            ...(key === f.target.sessionKey ? f.nativeEntry()! : { sessionId: "sibling" }),
            updatedAt: 2,
            label,
          }),
        ),
      );
    write(otherKey, "sibling");
    f.read();
    write(f.target.sessionKey, "before hydration");
    const hydrate = hydration.hydrateSessionActorState;
    let injected = 0;
    const observer = vi
      .spyOn(hydration, "hydrateSessionActorState")
      .mockImplementation((...args) => {
        const snapshot = hydrate(...args);
        if (injected++ < writes) {
          if (kind === "unscoped") {
            runSqliteImmediateTransactionSync(f.database.db, () => {
              f.database.db
                .prepare(
                  "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?) WHERE session_key = ?",
                )
                .run("after hydration", f.target.sessionKey);
            });
          } else {
            write(
              kind === "related" ? f.target.sessionKey : otherKey,
              `after hydration ${injected}`,
            );
          }
        }
        return snapshot;
      });
    try {
      if (writes === 2) {
        expect(() => f.read()).toThrow("Session actor changed while hydrating");
      } else {
        expect(f.read().entry?.label).toBe(
          kind === "unrelated"
            ? "before hydration"
            : kind === "related"
              ? "after hydration 1"
              : "after hydration",
        );
      }
      expect(observer).toHaveBeenCalledTimes(2);
    } finally {
      observer.mockRestore();
    }
  });
});

it("hydrates once and commits, rejects, and rolls back against the exact actor preimage", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    const database = f.database;
    const options = { agentId: "main", path: database.path };
    const scope = { ...f.scope, path: database.path };
    const identity = readOpenClawAgentDatabaseIdentity(database);
    if (typeof identity.identity !== "string") {
      throw new Error("Fixture requires a physical database");
    }
    const target: SessionActorTarget = {
      sessionKey: f.scope.sessionKey,
      database: {
        kind: "file",
        physicalIdentity: identity.identity,
        birthtime: identity.birthtime,
        nativeLocation: database.path,
      },
    };
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
    if (expected.kind !== "stage") {
      throw new Error("Expected pending-input stage facts");
    }
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
        kind: "resident",
        entries: [{ rawSeq: 1, eventId: "user" }],
      });
      expect(state.hot.transcript.idempotency).toEqual([
        { key: "first-user", eventId: "user", rawSeq: 1 },
      ]);
      expect(state.hot.completionKeys).toEqual([]);
      counter.counts.reads = 0;
      reads.length = 0;
      const working = cloneSessionActorStoredState(state);
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
      expect(postimage.transcript.anchors).toMatchObject([
        { entryId: "user" },
        { entryId: "assistant", effectiveParentId: "user" },
      ]);
      expect(postimage.transcript.modelContext).toEqual({
        kind: "resident",
        entries: [
          { rawSeq: 1, eventId: "user" },
          { rawSeq: 2, eventId: "assistant" },
        ],
      });
      expect(state.hot.entry?.activeWriterRunId).toBeUndefined();
      state = working;
    } finally {
      counter.restore();
    }
    expect(cachedEntries().entries.get(scope.sessionKey)?.label).toBe("actor committed");
    const committed = projectSessionActorHotState(state);
    const abandoned = cloneSessionActorStoredState(state);
    expect(() =>
      runOpenClawAgentWriteTransaction(
        (db) =>
          withSessionActorTransactionState(db, abandoned, () => {
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
    expect(projectSessionActorHotState(state)).toEqual(committed);
    expect(readSessionInputCompletion(database, pending)).toBeUndefined();
    expect(readSessionPendingInputByKey(database, scope, pending.idempotencyKey)?.input_id).toBe(
      "accepted-input",
    );
    const completed = cloneSessionActorStoredState(state);
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
    expect(completedPostimage.completionKeys).toEqual([pending.idempotencyKey]);
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
    const f = createSessionCompoundWorkerFixture();
    const database = f.database;
    const options = { agentId: "main", path: database.path };
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: f.scope.sessionKey,
      sessionId: f.scope.sessionId,
    };
    const identity = readOpenClawAgentDatabaseIdentity(database);
    if (typeof identity.identity !== "string") {
      throw new Error("Fixture requires a physical database");
    }
    const target: SessionActorTarget = {
      sessionKey: scope.sessionKey,
      database: {
        kind: "file",
        physicalIdentity: identity.identity,
        birthtime: identity.birthtime,
        nativeLocation: database.path,
      },
    };
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
    const retainedReads = trackSqliteStatementExecutions(
      database.db,
      ["entry", "newer"],
      (query) =>
        query.toLowerCase().includes('from "session_nodes"')
          ? "entry"
          : query.includes('"serialized_bytes"') && query.includes('"identity"."seq" >')
            ? "newer"
            : null,
    );
    const committed = (() => {
      try {
        return runOpenClawAgentWriteTransaction(
          (db) =>
            withSessionActorTransactionState(db, state, () =>
              applySessionActorAppend(append, state, context),
            ),
          options,
        );
      } finally {
        retainedReads.restore();
      }
    })();
    expect(retainedReads.counts.entry).toBe(0);
    expect(retainedReads.counts.newer).toBe(0);
    expect(committed.kind).toBe("metadata");
    if (committed.kind !== "metadata") {
      throw new Error("Expected prepared metadata append");
    }
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
    expect(committed.value.reload).toMatchObject({
      ok: true,
      value: {
        kind: "bounded",
        snapshot: {
          version: { rawSeq: 2 },
          events: [{ id: scope.sessionId }, { id: "retained-user" }, { id: "prepared-assistant" }],
        },
      },
    });
    expect(freshChecks).toBe(1);
    expect(f.events()).toHaveLength(3);
    const replay = runOpenClawAgentWriteTransaction(
      (db) =>
        withSessionActorTransactionState(db, state, () =>
          applySessionActorAppend({ kind: "metadata", input: append.input }, state, context),
        ),
      options,
    );
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
    const abandoned = cloneSessionActorStoredState(state);
    expect(() =>
      runOpenClawAgentWriteTransaction(
        (db) =>
          withSessionActorTransactionState(db, abandoned, () =>
            applySessionActorAppend(
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
              context,
            ),
          ),
        options,
      ),
    ).toThrow("fresh authority revoked");
    const directAbandoned = cloneSessionActorStoredState(state);
    expect(() =>
      runOpenClawAgentWriteTransaction(
        (db) =>
          withSessionActorTransactionState(db, directAbandoned, () =>
            applySessionActorAppend(
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
              context,
            ),
          ),
        options,
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
    runOpenClawAgentWriteTransaction(
      (db) =>
        withSessionActorTransactionState(db, state, () =>
          applySessionActorAppend(
            {
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
            },
            state,
            context,
          ),
        ),
      options,
    );
    expect(() =>
      runOpenClawAgentWriteTransaction(
        (db) =>
          withSessionActorTransactionState(db, state, () =>
            applySessionActorAppend(
              {
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
              },
              state,
              context,
            ),
          ),
        options,
      ),
    ).toThrow("changed");
    expect(f.events().at(-1)).toMatchObject({ id: "newer-user" });
  });
});
