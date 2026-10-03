import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createChatSendGoalCommitGuard } from "../../gateway/server-methods/chat-send-work-admission.js";
import { loadSessionEntry as loadGatewaySessionEntry } from "../../gateway/session-utils.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
} from "./session-accessor.pending-inputs.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { readCommittedTranscriptMessageSequence } from "./session-accessor.sqlite-transcript-sequences.js";
import { appendExpectedSessionTranscriptTurn } from "./session-accessor.sqlite-transcript-turn.js";
import type { SessionTranscriptTurnPersistOptions } from "./session-accessor.types.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";

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

afterEach(() => {
  delivery.afterCommit = undefined;
  vi.restoreAllMocks();
});

it.each(["fresh", "replay"])(
  "fences unstaged original input at COMMIT while retaining %s semantics",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      let live = true;
      const assertCurrent = vi.fn(() => {
        if (!live) {
          throw new Error("original input authority closed");
        }
      });
      const recorder = () =>
        createUserTurnTranscriptRecorder({
          message: {
            role: "user",
            content: "synthetic command",
            timestamp: Date.now(),
            idempotencyKey: "unstaged-command",
          },
          target: { ...f.scope, expectedSessionId: f.scope.sessionId, sessionEntry: f.read() },
          assertOriginalInputCommit: assertCurrent,
          beforeMessageWrite: ({ message }) => {
            assertCurrent();
            return message;
          },
          onPersistenceError: () => {},
          updateMode: "none",
        });
      if (mode === "replay") {
        await recorder().persistFallback();
        live = false;
        assertCurrent.mockClear();
      }
      let commitSeen = false;
      const create = admission.createSqliteWorkerOperationAdmission;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) =>
          create((request, grant) => {
            if (request.stage === "commit") {
              commitSeen = true;
              live = false;
            }
            callback(request, grant);
          }, attachment),
      );
      if (mode === "fresh") {
        await expect(recorder().persistFallback()).rejects.toThrow(
          "original input authority closed",
        );
        expect(commitSeen).toBe(true);
        expect(f.events()).toEqual([]);
      } else {
        await expect(recorder().persistFallback()).resolves.toMatchObject({ appended: false });
        expect(assertCurrent).not.toHaveBeenCalled();
        expect(f.events().filter((event) => event.type === "message")).toHaveLength(1);
      }
    });
  },
);

it("publishes an acknowledged turn exactly once after a lost worker reply", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const committed = vi.fn();
    const lostReply = vi.fn();
    delivery.afterCommit = (type) => {
      if (type === "session.turn.commit") {
        lostReply();
        throw new Error("worker reply lost after COMMIT");
      }
    };
    const result = await appendExpectedSessionTranscriptTurn(f.scope, {
      expectedSessionId: f.scope.sessionId,
      sessionFile: "synthetic-session.jsonl",
      messages: [{ eventId: "acknowledged-turn", message: { role: "user", content: "committed" } }],
      onMessageCommitted: committed,
    });
    expect(result.appendedMessages).toMatchObject([
      { messageId: "acknowledged-turn", appended: true },
    ]);
    expect(f.events().filter((event) => event.id === "acknowledged-turn")).toHaveLength(1);
    expect(lostReply).toHaveBeenCalledOnce();
    expect(committed).toHaveBeenCalledOnce();
  });
});

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

it("refuses revoked authority at the turn COMMIT grant", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    let current = true;
    const refusal = new Error("compound authority revoked");
    const assertCurrent = () => {
      if (!current) {
        throw refusal;
      }
    };
    const pending = await stageSessionPendingInput(f.scope, {
      runId: "revoked-turn",
      message: {
        role: "user",
        content: "must remain queued",
        timestamp: 1,
        idempotencyKey: "revoked:user",
      },
      assertCurrent,
    });
    expect(pending).toBeDefined();
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    let finalGrant = false;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (callback, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            finalGrant = true;
            expect(pending!.state).toBe("queued");
            current = false;
          }
          callback(request, grant);
        }, attachment),
    );
    const committed = vi.fn();
    try {
      const work = pending!.run(() =>
        appendExpectedSessionTranscriptTurn(f.scope, {
          expectedSessionId: f.scope.sessionId,
          sessionFile: "synthetic-session.jsonl",
          messages: [{ message: pending!.message }],
          onMessageCommitted: committed,
        }),
      );
      await expect(work).rejects.toBe(refusal);
      expect(finalGrant).toBe(true);
      expect(committed).not.toHaveBeenCalled();
      expect(pending!.state).toBe("queued");
      expect(f.read()?.sessionId).toBe("original");
      expect(f.events()).toEqual([]);
    } finally {
      pending!.finish("interrupted");
    }
  });
});

it("joins concurrent turn completions in physical FIFO order", async ({ signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const order: string[] = [];
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
      second = appendExpectedSessionTranscriptTurn(f.scope, {
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
      });
      expect(order).toEqual(["turn:callback"]);
      release.resolve();
      await withinTest(Promise.all([first, second]), signal);
      expect(order).toEqual([
        "turn:callback",
        "turn:completion",
        "second:prepare",
        "second:callback",
      ]);
      expect(f.events()).toContainEqual(
        expect.objectContaining({ type: "message", id: "second-turn", parentId: "first-turn" }),
      );
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
  });
});

function fixture() {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const scope = {
    agentId: "main",
    storePath: database.path,
    sessionKey: "agent:main:compound-worker",
    sessionId: "original",
  };
  replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1, label: "initial" });
  return {
    database,
    scope,
    read: () => readExactSessionEntryRow(database, scope.sessionKey)?.entry,
    events: () =>
      readTranscriptEventRows(database, scope.sessionId).map((row) => JSON.parse(row.eventJson)),
  };
}

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
