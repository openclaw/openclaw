import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import { createChatSendGoalCommitGuard } from "../../gateway/server-methods/chat-send-work-admission.js";
import { loadSessionEntry as loadGatewaySessionEntry } from "../../gateway/session-utils.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
} from "./session-accessor.pending-inputs.js";
import { replaceSessionEntry, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { resetSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import { readCommittedTranscriptMessageSequence } from "./session-accessor.sqlite-transcript-sequences.js";
import { appendExpectedSessionTranscriptTurn } from "./session-accessor.sqlite-transcript-turn.js";
import type { SessionTranscriptTurnPersistOptions } from "./session-accessor.types.js";
import { createSessionCompoundWorkerFixture as fixture } from "./session-compound-worker.test-support.js";
import { SqliteSessionMutationConflictError } from "./session-mutation-conflict-error.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import * as transcriptReconcile from "./session-transcript-reconcile.js";

vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const delivery = vi.hoisted(() => ({
  afterCommit: undefined as ((type: string) => void) | undefined,
}));
vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owner = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owner,
        get fileIdentity() {
          return owner.fileIdentity;
        },
        runExisting: (source, operation, options) =>
          owner.runExisting(
            source,
            (worker) =>
              operation({
                execute: async (command, commandOptions) => {
                  const result = await worker.execute(command, commandOptions);
                  delivery.afterCommit?.(command.type);
                  return result;
                },
              }),
            options,
          ),
      };
    },
  };
});

const resetFault = useSqliteWorkerFault([
  {
    name: "reject_reset_reactions",
    match: /^delete from session_reactions /,
    sql: `CREATE TEMP TRIGGER reject_reset_reactions BEFORE DELETE ON main.session_reactions
      BEGIN SELECT RAISE(ABORT, 'synthetic reset collaboration refusal'); END;`,
  },
]);

afterEach(() => {
  delivery.afterCommit = undefined;
  vi.restoreAllMocks();
});

it.each(["turn", "reset"] as const)(
  "publishes an acknowledged %s exactly once after a lost worker reply",
  async (operation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const committed = vi.fn();
      const lostReply = vi.fn();
      delivery.afterCommit = (type) => {
        if (type === (operation === "turn" ? "session.turn.commit" : "session.lifecycle.reset")) {
          lostReply();
          throw new Error("worker reply lost after COMMIT");
        }
      };
      if (operation === "turn") {
        const result = await appendExpectedSessionTranscriptTurn(f.scope, {
          expectedSessionId: f.scope.sessionId,
          sessionFile: "synthetic-session.jsonl",
          messages: [
            { eventId: "acknowledged-turn", message: { role: "user", content: "committed" } },
          ],
          onMessageCommitted: committed,
        });
        expect(result.appendedMessages).toMatchObject([
          { messageId: "acknowledged-turn", appended: true },
        ]);
        expect(f.events().filter((event) => event.id === "acknowledged-turn")).toHaveLength(1);
      } else {
        const buildNextEntry = vi.fn(() => ({ sessionId: "acknowledged-reset", updatedAt: 2 }));
        const result = await resetSessionEntryLifecycle({
          ...f.scope,
          target: f.target,
          resetBoundary: { context: "clear", reason: "new", cwd: "/synthetic/workspace" },
          buildNextEntry,
          afterEntryMutation: committed,
        });
        expect(result.nextEntry.sessionId).toBe("acknowledged-reset");
        expect(f.read()?.sessionId).toBe("acknowledged-reset");
        expect(f.events().filter((event) => event.type === "reset")).toHaveLength(1);
        expect(buildNextEntry).toHaveBeenCalledOnce();
      }
      expect(lostReply).toHaveBeenCalledOnce();
      expect(committed).toHaveBeenCalledOnce();
    });
  },
);

it("rolls back the turn and its pending-input custody after an idempotency conflict", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const committed = vi.fn();
    const before = f.read();
    const pending = await stageSessionPendingInput(f.scope, {
      runId: "rollback-turn",
      message: { role: "user", content: "first", timestamp: 1, idempotencyKey: "rollback:user" },
      assertCurrent() {},
    });
    expect(pending).toBeDefined();
    try {
      await expect(
        pending!.run(() =>
          appendExpectedSessionTranscriptTurn(f.scope, {
            expectedSessionId: f.scope.sessionId,
            sessionFile: "synthetic-session.jsonl",
            messages: [
              { message: pending!.message },
              {
                message: {
                  role: "assistant",
                  content: "conflicting second append",
                  idempotencyKey: "rollback:user",
                },
              },
            ],
            onMessageCommitted: committed,
          }),
        ),
      ).rejects.toThrow("conflicts with the admitted message");
      expect(pending!.state).toBe("queued");
      expect(committed).not.toHaveBeenCalled();
      expect(f.read()).toEqual(before);
      expect(f.events()).toEqual([]);
    } finally {
      pending!.finish("interrupted");
    }
  });
});

it.each([
  { operation: "turn", stage: "commit" },
  { operation: "reset", stage: "transaction" },
  { operation: "reset", stage: "commit" },
] as const)(
  "refuses revoked authority at the $operation $stage grant",
  async ({ operation, stage }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const before = f.read();
      let current = true;
      let resetPrepared = false;
      const refusal = new Error("compound authority revoked");
      const assertCurrent = () => {
        if (!current) {
          throw refusal;
        }
      };
      const pending =
        operation === "turn"
          ? await stageSessionPendingInput(f.scope, {
              runId: "revoked-turn",
              message: {
                role: "user",
                content: "must remain queued",
                timestamp: 1,
                idempotencyKey: "revoked:user",
              },
              assertCurrent,
            })
          : undefined;
      if (operation === "turn") {
        expect(pending).toBeDefined();
      }
      const createAdmission = admission.createSqliteWorkerOperationAdmission;
      let finalGrant = false;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === stage && (operation === "turn" || resetPrepared)) {
              finalGrant = true;
              if (pending) {
                expect(pending.state).toBe("queued");
              }
              current = false;
            }
            callback(request, grant);
          }, attachment),
      );
      const committed = vi.fn();
      try {
        const work =
          operation === "turn"
            ? pending!.run(() =>
                appendExpectedSessionTranscriptTurn(f.scope, {
                  expectedSessionId: f.scope.sessionId,
                  sessionFile: "synthetic-session.jsonl",
                  messages: [{ message: pending!.message }],
                  onMessageCommitted: committed,
                }),
              )
            : resetSessionEntryLifecycle({
                ...f.scope,
                target: f.target,
                commitGuard: assertCurrent,
                resetBoundary: { context: "clear", reason: "new", cwd: "/synthetic/workspace" },
                buildNextEntry() {
                  resetPrepared = true;
                  return { sessionId: "revoked-reset", updatedAt: 2 };
                },
                afterEntryMutation: committed,
              });
        await expect(work).rejects.toBe(refusal);
        expect(finalGrant).toBe(true);
        expect(committed).not.toHaveBeenCalled();
        if (pending) {
          expect(pending.state).toBe("queued");
        }
        expect(f.read()).toEqual(before);
        expect(f.events()).toEqual([]);
      } finally {
        pending?.finish("interrupted");
      }
    });
  },
);

it.for(["turn", "reset"] as const)(
  "joins a turn completion and concurrent %s in physical FIFO order",
  async (operation, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const order: string[] = [];
      const stopIdentity = onSessionIdentityMutation((change) => {
        if (change.kind === "reset" && change.current.sessionId === "fifo-reset") {
          order.push("reset:identity");
        }
      });
      const first = appendExpectedSessionTranscriptTurn(f.scope, {
        expectedSessionId: f.scope.sessionId,
        sessionFile: "synthetic-session.jsonl",
        messages: [{ eventId: "first-turn", message: { role: "user", content: "first" } }],
        onMessageCommitted(_message, accept) {
          order.push("turn:callback");
          accept(async () => {
            entered.resolve();
            await release.promise;
            order.push("turn:completion");
          });
        },
      });
      let second: Promise<unknown> | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, first, "turn skipped completion"),
          signal,
        );
        second =
          operation === "turn"
            ? appendExpectedSessionTranscriptTurn(f.scope, {
                expectedSessionId: f.scope.sessionId,
                sessionFile: "synthetic-session.jsonl",
                messages: [
                  {
                    eventId: "second-turn",
                    message: { role: "user", content: "second" },
                    shouldAppend() {
                      order.push("second:prepare");
                      return true;
                    },
                  },
                ],
                onMessageCommitted() {
                  order.push("second:callback");
                },
              })
            : resetSessionEntryLifecycle({
                ...f.scope,
                target: f.target,
                resetBoundary: {
                  context: "preserve-tail",
                  reason: "reset",
                  cwd: "/synthetic/workspace",
                },
                buildNextEntry({ currentEntry }) {
                  order.push(`reset:build:${currentEntry?.sessionId}`);
                  return { sessionId: "fifo-reset", updatedAt: 2 };
                },
                afterEntryMutation() {
                  order.push("reset:after");
                },
              });
        expect(order).toEqual(["turn:callback"]);
        release.resolve();
        await withinTest(Promise.all([first, second]), signal);
        expect(order).toEqual(
          operation === "turn"
            ? ["turn:callback", "turn:completion", "second:prepare", "second:callback"]
            : [
                "turn:callback",
                "turn:completion",
                "reset:build:original",
                "reset:identity",
                "reset:after",
              ],
        );
        expect(f.events()).toContainEqual(
          expect.objectContaining(
            operation === "turn"
              ? { type: "message", id: "second-turn", parentId: "first-turn" }
              : { type: "reset", parentId: "first-turn" },
          ),
        );
      } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
        stopIdentity();
      }
    });
  },
);

it("commits a reset with zero host SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const committed = vi.fn();
    const sql = observeHostDataSql();
    try {
      const result = await resetSessionEntryLifecycle({
        ...f.scope,
        target: f.target,
        resetBoundary: { context: "clear", reason: "new", cwd: "/synthetic/workspace" },
        buildNextEntry: () => ({ sessionId: "host-sql-reset", updatedAt: 2 }),
        afterEntryMutation: committed,
      });
      expect(result).toMatchObject({
        previousSessionId: "original",
        nextEntry: { sessionId: "host-sql-reset" },
        archivedTranscripts: [],
      });
      expect(sql.queries.length, `T1 reset host SQL observations: ${sql.queries.length}`).toBe(0);
      expect(committed).toHaveBeenCalledOnce();
    } finally {
      sql.restore();
    }
    expect(f.read()?.sessionId).toBe("host-sql-reset");
    expect(f.events().filter((event) => event.type === "reset")).toHaveLength(1);
  });
});

it("reconciles a dirty reset transcript through the host owner after commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    await appendExpectedSessionTranscriptTurn(f.scope, {
      expectedSessionId: f.scope.sessionId,
      sessionFile: "synthetic-session.jsonl",
      messages: [
        { eventId: "dirty-reset-seed", message: { role: "user", content: "Retained history" } },
      ],
    });
    f.database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(f.scope.sessionId);
    const projection = () =>
      f.database.db
        .prepare(
          "SELECT needs_rebuild, indexed_seq, leaf_event_id FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(f.scope.sessionId);
    expect(projection()).toMatchObject({ needs_rebuild: 1 });
    const reconcile = vi.spyOn(transcriptReconcile, "startSessionTranscriptIndexReconcile");
    const databaseOptions = { agentId: f.scope.agentId, path: f.database.path };
    try {
      await resetSessionEntryLifecycle({
        ...f.scope,
        target: f.target,
        resetBoundary: {
          context: "clear",
          reason: "new",
          cwd: "/synthetic/workspace",
          boundaryId: "dirty-reset-boundary",
        },
        buildNextEntry: () => ({ sessionId: "dirty-reset-successor", updatedAt: 2 }),
      });
      expect(reconcile).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ...databaseOptions,
          preferredSessionId: "original",
        }),
      );
    } finally {
      await transcriptReconcile.waitForSessionTranscriptIndexReconcile(databaseOptions);
    }
    expect(projection()).toEqual({
      needs_rebuild: 0,
      indexed_seq: 2,
      leaf_event_id: "dirty-reset-boundary",
    });
    expect(f.read()?.sessionId).toBe("dirty-reset-successor");
  });
});

it("preserves reset conflict identity and does not overwrite a concurrent entry", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const concurrent = { sessionId: "original", updatedAt: 2, label: "concurrent writer" };
    const replaceAfterSelection = vi.fn(() => replaceSessionEntrySync(f.scope, concurrent));
    delivery.afterCommit = (type) => {
      if (type === "session.entry.patch.prepare") {
        replaceAfterSelection();
      }
    };
    const buildNextEntry = vi.fn<
      Parameters<typeof resetSessionEntryLifecycle>[0]["buildNextEntry"]
    >(({ currentEntry }) => {
      expect(currentEntry?.label).toBe("initial");
      return { sessionId: "rejected-reset", updatedAt: 3 };
    });
    const committed = vi.fn();
    const work = resetSessionEntryLifecycle({
      ...f.scope,
      target: f.target,
      buildNextEntry,
      afterEntryMutation: committed,
    });
    await expect(work).rejects.toBeInstanceOf(SqliteSessionMutationConflictError);
    await expect(work).rejects.toMatchObject({ operationLabel: "reset" });
    expect(replaceAfterSelection).toHaveBeenCalledOnce();
    expect(buildNextEntry).toHaveBeenCalledOnce();
    expect(committed).not.toHaveBeenCalled();
    expect(f.read()).toMatchObject(concurrent);
    expect(f.events()).toEqual([]);
  });
});

it("rolls collaboration cleanup back with a refused reset and clears only the committed target", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const siblingKey = "agent:main:compound-sibling";
    await replaceSessionEntry(
      { ...f.scope, sessionKey: siblingKey },
      { sessionId: "sibling", updatedAt: 1 },
    );
    for (const key of [f.scope.sessionKey, siblingKey]) {
      f.database.db
        .prepare(
          "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, ?, ?, ?)",
        )
        .run(key, "synthetic-member", "synthetic-owner", 1);
      f.database.db
        .prepare(
          "INSERT INTO session_suggestions (id, session_key, author_id, text, created_at, state) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(`suggestion:${key}`, key, "synthetic-member", "Synthetic suggestion", 1, "pending");
      f.database.db
        .prepare(
          "INSERT INTO session_reactions (session_key, session_id, message_id, emoji, identity_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          key,
          key === siblingKey ? "sibling" : "original",
          "synthetic-message",
          "👍",
          "synthetic-member",
          1,
        );
    }
    const collaboration = (key: string) =>
      ["session_members", "session_suggestions", "session_reactions"].map((table) =>
        f.database.db.prepare(`SELECT * FROM ${table} WHERE session_key = ?`).all(key),
      );
    const before = collaboration(f.scope.sessionKey);
    const siblingBefore = collaboration(siblingKey);
    const entryBefore = f.read();
    const committed = vi.fn();
    const reset = () =>
      resetSessionEntryLifecycle({
        ...f.scope,
        target: f.target,
        resetBoundary: { context: "clear", reason: "new", cwd: "/synthetic/workspace" },
        buildNextEntry: () => ({ sessionId: "collaboration-reset", updatedAt: 2 }),
        afterEntryMutation: committed,
      });
    resetFault.enable();
    try {
      await expect(reset()).rejects.toThrow("synthetic reset collaboration refusal");
      expect(collaboration(f.scope.sessionKey)).toEqual(before);
      expect(collaboration(siblingKey)).toEqual(siblingBefore);
      expect(f.read()).toEqual(entryBefore);
      expect(f.events()).toEqual([]);
      expect(committed).not.toHaveBeenCalled();
    } finally {
      resetFault.disable();
    }
    await reset();
    expect(collaboration(f.scope.sessionKey)).toEqual([[], [], []]);
    expect(collaboration(siblingKey)).toEqual(siblingBefore);
    expect(f.read()?.sessionId).toBe("collaboration-reset");
    expect(f.events().filter((event) => event.type === "reset")).toHaveLength(1);
    expect(committed).toHaveBeenCalledOnce();
  });
});

it("preserves worker custody refusal identity so callers cannot fall back to another dispatch", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const message = {
      role: "user" as const,
      content: "owned input",
      timestamp: 1,
      idempotencyKey: "owned-input",
    };
    const pending = await stageSessionPendingInput(f.scope, {
      runId: "custody-refusal",
      message,
      assertCurrent() {},
    });
    expect(pending).toBeDefined();
    try {
      await expect(
        appendExpectedSessionTranscriptTurn(f.scope, {
          expectedSessionId: f.scope.sessionId,
          sessionFile: "synthetic-session.jsonl",
          messages: [{ message }],
        }),
      ).rejects.toBeInstanceOf(SessionPendingInputCustodyError);
      expect(pending!.state).toBe("queued");
      expect(f.events()).toEqual([]);
    } finally {
      pending!.finish("interrupted");
    }
  });
});

it("commits a pending-input turn with zero host SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const pending = await stageSessionPendingInput(f.scope, {
      runId: "compound-turn",
      message: {
        role: "user",
        content: "synthetic input",
        timestamp: 1,
        idempotencyKey: "compound:user",
      },
      assertCurrent() {},
    });
    expect(pending).toBeDefined();
    const grantStates: string[] = [];
    const observedCustody: string[] = [];
    const stopRows = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === f.scope.sessionKey) {
        observedCustody.push(pending!.state);
      }
    });
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (callback, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            grantStates.push(pending!.state);
          }
          callback(request, grant);
        }, attachment),
    );
    const committed = vi.fn<NonNullable<SessionTranscriptTurnPersistOptions["onMessageCommitted"]>>(
      (message) => {
        expect(pending!.state).toBe("consumed");
        expect(readCommittedTranscriptMessageSequence(message)).toBe(1);
      },
    );
    const turnRequests: string[] = [];
    delivery.afterCommit = (type) => {
      if (type.startsWith("session.turn.")) {
        turnRequests.push(type);
      }
    };
    const sql = observeHostDataSql();
    try {
      const turn = await pending!.run(() =>
        appendExpectedSessionTranscriptTurn(f.scope, {
          expectedSessionId: f.scope.sessionId,
          sessionFile: "synthetic-session.jsonl",
          touchSessionEntry: true,
          messages: [{ message: pending!.message }],
          onMessageCommitted: committed,
        }),
      );
      expect(turn.appendedMessages).toHaveLength(1);
      expect(readCommittedTranscriptMessageSequence(turn.appendedMessages[0]!)).toBe(1);
      expect(pending!.state).toBe("consumed");
      expect(sql.queries, `T1 host SQL observations: ${sql.queries.length}`).toEqual([]);
      expect(grantStates.length).toBeGreaterThan(0);
      expect(new Set(grantStates)).toEqual(new Set(["queued"]));
      expect(committed).toHaveBeenCalledOnce();
      expect(observedCustody.length).toBeGreaterThan(0);
      expect(new Set(observedCustody)).toEqual(new Set(["consumed"]));
      expect(turnRequests.length, "pending-input promotion request budget").toBeLessThanOrEqual(2);
    } finally {
      sql.restore();
      stopRows();
      pending!.finish("interrupted");
    }
    expect(f.read()?.sessionId).toBe("original");
    expect(f.events()).toContainEqual(
      expect.objectContaining({ type: "message", id: pending!.inputId }),
    );
  });
});

it("evaluates the latest-assistant predicate against earlier writes in the same turn", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "already appended" }],
      stopReason: "stop",
      __openclaw: { runId: "same-run" },
    };
    const committed = vi.fn();
    const turnRequests: string[] = [];
    delivery.afterCommit = (type) => {
      if (type.startsWith("session.turn.")) {
        turnRequests.push(type);
      }
    };
    const sql = observeHostDataSql();
    try {
      const result = await appendExpectedSessionTranscriptTurn(f.scope, {
        expectedSessionId: f.scope.sessionId,
        sessionFile: "synthetic-session.jsonl",
        messages: [
          { eventId: "first-assistant", message },
          {
            eventId: "duplicate-assistant",
            message,
            predicate: {
              kind: "latest-assistant-differs",
              runId: "same-run",
              text: "already appended",
            },
          },
        ],
        onMessageCommitted: committed,
      });
      expect(result.appendedMessages).toMatchObject([{ messageId: "first-assistant" }]);
      expect(committed).toHaveBeenCalledOnce();
      expect(sql.queries).toEqual([]);
      expect(turnRequests.length, "fixed transcript append request budget").toBeLessThanOrEqual(1);
    } finally {
      sql.restore();
    }
    expect(f.events().filter((event) => event.type === "message")).toMatchObject([
      { id: "first-assistant", message },
    ]);
    const prepare = vi.fn(() => undefined);
    const dependent = await appendExpectedSessionTranscriptTurn(f.scope, {
      expectedSessionId: f.scope.sessionId,
      sessionFile: "synthetic-session.jsonl",
      messages: [
        {
          message: { ...message, idempotencyKey: "dependent" },
          predicate: {
            kind: "latest-assistant-differs",
            runId: "same-run",
            text: "already appended",
          },
        },
        {
          message: { ...message, idempotencyKey: "dependent" },
          workerPreparation: { prepareMessageAfterIdempotencyCheck: prepare },
        },
      ],
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(dependent.appendedMessages).toEqual([]);
    expect(f.events().filter((event) => event.type === "message")).toHaveLength(1);
  });
});

it("replays an exactly consumed input after its live custody has finished", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const pending = await stageSessionPendingInput(f.scope, {
      runId: "finished-turn",
      message: {
        role: "user",
        content: "committed input",
        timestamp: 1,
        idempotencyKey: "finished:user",
      },
      assertCurrent() {},
    });
    expect(pending).toBeDefined();
    const append = (message: unknown) =>
      appendExpectedSessionTranscriptTurn(f.scope, {
        expectedSessionId: f.scope.sessionId,
        sessionFile: "synthetic-session.jsonl",
        messages: [{ message }],
      });
    try {
      await pending!.run(() => append(pending!.message));
      expect(pending!.state).toBe("consumed");
      pending!.finish("cancelled");
      const result = await withSessionPendingInputPersistence(pending!, () =>
        append(pending!.message),
      );
      expect(result.appendedMessages).toMatchObject([
        { appended: false, messageId: pending!.inputId },
      ]);
      const replay = await withSessionPendingInputPersistence(pending!, () =>
        append({ ...pending!.message, content: "different input" }),
      );
      expect(replay.appendedMessages[0]?.message).toEqual(pending!.message);
      expect(f.events().filter((event) => event.type === "message")).toMatchObject([
        { id: pending!.inputId, message: pending!.message },
      ]);
    } finally {
      pending!.finish("cancelled");
    }
  });
});

it("prepares a goal message with the same intent that commits with the goal", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    let observed: unknown;
    const prepare = vi.fn((message: unknown) => {
      observed = structuredClone(message);
      return message;
    });
    const result = await appendExpectedSessionTranscriptTurn(f.scope, {
      expectedSessionId: f.scope.sessionId,
      sessionFile: "synthetic-session.jsonl",
      sessionTurnMutation: {
        kind: "goal",
        runId: "goal-run",
        operation: {
          action: "start",
          objective: "complete the synthetic task",
          operationId: "goal-operation",
          requestFingerprint: "goal-fingerprint",
          issuedAtMs: Date.now(),
        },
      },
      messages: [
        {
          eventId: "goal-message",
          message: { role: "user", content: "complete the synthetic task" },
          workerPreparation: { prepareMessageAfterIdempotencyCheck: prepare },
        },
      ],
    });
    expect(prepare).toHaveBeenCalledOnce();
    const intent = {
      kind: "session-goal-start",
      version: 1,
      goalId: result.sessionTurnMutationResult?.result.goalId,
      operationId: "goal-operation",
    };
    expect(intent.goalId).toEqual(expect.any(String));
    expect(observed).toMatchObject({ __openclaw: { intent } });
    expect(f.read()?.goal?.id).toBe(intent.goalId);
    expect(f.events()).toContainEqual(
      expect.objectContaining({
        id: "goal-message",
        message: expect.objectContaining({ __openclaw: expect.objectContaining({ intent }) }),
      }),
    );
    const invalidPrepare = vi.fn((message: unknown) => message);
    await expect(
      appendExpectedSessionTranscriptTurn(f.scope, {
        expectedSessionId: f.scope.sessionId,
        sessionFile: "synthetic-session.jsonl",
        sessionTurnMutation: {
          kind: "goal",
          runId: "invalid-goal-run",
          operation: {
            action: "start",
            objective: "another goal",
            operationId: "invalid-goal",
            requestFingerprint: "invalid-goal-fingerprint",
            issuedAtMs: Date.now(),
          },
        },
        messages: [
          {
            message: { role: "user", content: "another goal" },
            workerPreparation: { prepareMessageAfterIdempotencyCheck: invalidPrepare },
          },
        ],
      }),
    ).rejects.toThrow("goal already exists");
    expect(invalidPrepare).not.toHaveBeenCalled();
  });
});

it.each(["commit", "captured-root", "native-replay"])(
  "keeps real first-Goal admission grants free of host session SQL (%s)",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      if (mode === "native-replay") {
        await state.writeConfig({
          agents: { entries: { main: { workspace: state.workspaceDir } } },
          session: { store: state.statePath("alternate", "{agentId}", "sessions.json") },
        });
      }
      const key = "agent:main:compound-goal-guard";
      const target = loadGatewaySessionEntry(key, { agentId: "main" });
      const initialSessionEntry = { sessionId: "guarded-first-goal", updatedAt: Date.now() };
      const guard = createChatSendGoalCommitGuard({
        client: null,
        // The guard consumes only this context operation; authentication is the existing internal-client path.
        context: { getRuntimeConfig: () => target.cfg } as Parameters<
          typeof createChatSendGoalCommitGuard
        >[0]["context"],
        admission: {
          initialSessionEntry,
          activeRunAbort: { controller: new AbortController() },
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        },
        session: {
          agentId: target.agentId,
          sessionLoadKey: key,
          sessionLoadOptions: { agentId: "main" },
          sessionKey: target.canonicalKey,
          storePath: target.storePath,
          sessionRoutingChanged: () => false,
        },
      });
      const env = { ...process.env };
      if (mode === "captured-root") {
        vi.stubEnv(
          "OPENCLAW_STATE_DIR",
          path.join(path.dirname(target.storePath), "successor-root"),
        );
      }
      const sql = observeHostDataSql();
      const grants: string[] = [];
      let commitSeen = false;
      const create = admission.createSqliteWorkerOperationAdmission;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) =>
          create((request, grant) => {
            const before = sql.queries.length;
            try {
              callback(request, grant);
            } finally {
              if (request.stage === "commit") {
                commitSeen = true;
                grants.push(...sql.queries.slice(before));
              }
            }
          }, attachment),
      );
      try {
        const scope = {
          env,
          agentId: target.agentId,
          storePath: target.storePath,
          sessionKey: target.canonicalKey,
          sessionId: initialSessionEntry.sessionId,
        };
        const options = {
          keyFormat: "agent-qualified" as const,
          expectedSessionId: initialSessionEntry.sessionId,
          selectedSessionId: null,
          initialSessionEntry,
          sessionFile: target.canonicalKey,
          sessionTurnMutation: {
            kind: "goal" as const,
            runId: "guarded-goal-run",
            ...guard,
            operation: {
              action: "start" as const,
              objective: "synthetic guarded goal",
              operationId: "guarded-goal-operation",
              requestFingerprint: "guarded-goal-fingerprint",
              issuedAtMs: Date.now(),
            },
          },
          messages: [{ message: { role: "user", content: "synthetic guarded goal" } }],
        };
        await appendExpectedSessionTranscriptTurn(scope, options);
        if (mode === "native-replay") {
          replaceSessionEntrySync(
            {
              ...scope,
              storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
            },
            { ...initialSessionEntry, sessionId: "competing-goal-session" },
          );
          expect(() => loadGatewaySessionEntry(key, { agentId: "main" }, target.cfg)).toThrow(
            /duplicate/i,
          );
          await expect(
            appendExpectedSessionTranscriptTurn(scope, {
              ...options,
              messages: options.messages.map((append) =>
                Object.assign({}, append, {
                  prepareMessageAfterIdempotencyCheck: (message: unknown) => message,
                }),
              ),
            }),
          ).rejects.toThrow(/duplicate|routing changed/i);
        }
        expect(commitSeen).toBe(true);
        expect(grants, `Goal grant host SQL observations: ${grants.length}`).toEqual([]);
      } finally {
        sql.restore();
        if (mode === "captured-root") {
          vi.unstubAllEnvs();
        }
      }
    });
  },
);
