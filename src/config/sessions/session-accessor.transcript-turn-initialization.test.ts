import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { readSessionGoalOperationInDatabase } from "./goals-operations.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
  type SessionTranscriptTurnPersistOptions,
} from "./session-accessor.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

describe("first transcript turn initialization", () => {
  const fixture = useTempSessionsFixture("openclaw-first-goal-turn-");
  const now = 1_800_000_000_000;
  const sessionId = "first-goal-session";
  const scope = () => ({
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId,
    storePath: fixture.storePath(),
  });
  const operation = {
    action: "start" as const,
    operationId: "first-goal-operation",
    issuedAtMs: now,
    requestFingerprint: "first-goal-fingerprint",
    objective: "  /stop\nkeep the objective literal\n",
  };
  const initialSessionEntry: SessionEntry = {
    sessionId,
    updatedAt: now,
    sessionStartedAt: now,
    lifecycleRevision: "first-lifecycle",
    createdAt: now,
    createdVia: "operator",
    createdActor: { type: "human", source: "profile", id: "operator-profile" },
    sandbox: "required",
  };
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
  const counts = () =>
    database()
      .db.prepare(
        `SELECT
          (SELECT count(*) FROM session_nodes) AS nodes,
          (SELECT count(*) FROM session_windows) AS windows,
          (SELECT count(*) FROM transcript_events) AS events,
          (SELECT count(*) FROM session_goal_operations) AS receipts`,
      )
      .get();
  const admit = (options: Partial<SessionTranscriptTurnPersistOptions> = {}) =>
    persistSessionTranscriptTurn(scope(), {
      expectedSessionId: sessionId,
      initialSessionEntry,
      messages: [
        {
          message: {
            role: "user",
            content: operation.objective,
            idempotencyKey: `${operation.operationId}:user`,
          },
        },
      ],
      sessionTurnMutation: { kind: "goal", operation, runId: operation.operationId },
      sessionLifecyclePatch: {
        status: "running",
        lifecycleRunId: operation.operationId,
        restartRecoveryDeliveryRunId: operation.operationId,
        restartRecoveryDeliverySourceRunId: operation.operationId,
        restartRecoveryDeliveryRequestFingerprint: operation.requestFingerprint,
      },
      updateMode: "none",
      ...options,
    });

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
  });

  it("creates the first session, Goal, input and run receipt atomically and replays after reopen", async () => {
    expect(loadSessionEntry(scope())).toBeUndefined();
    const onMessageCommitted = vi.fn(({ messageId }: { messageId: string }) => {
      expect(loadTranscriptEventsSync(scope())).toContainEqual(
        expect.objectContaining({
          id: messageId,
          message: expect.objectContaining({ role: "user" }),
        }),
      );
    });
    const turn = await admit({ onMessageCommitted });
    expect(turn).toMatchObject({
      appendedCount: 1,
      sessionEntry: {
        ...initialSessionEntry,
        status: "running",
        restartRecoveryDeliveryRunId: operation.operationId,
        goal: { objective: operation.objective, status: "active" },
      },
      sessionTurnMutationResult: {
        replayed: false,
        result: { action: "start", status: "started", sessionId, runId: operation.operationId },
      },
    });
    expect(turn.messages[0]?.message).toMatchObject({ content: operation.objective });
    expect(counts()).toEqual({ nodes: 1, windows: 1, events: 2, receipts: 1 });
    expect(
      readSessionGoalOperationInDatabase(database(), {
        ...scope(),
        expectedSessionId: sessionId,
        operation,
      }),
    ).toEqual(turn.sessionTurnMutationResult?.result);

    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const replay = await admit({ onMessageCommitted });
    expect(onMessageCommitted).toHaveBeenCalledTimes(1);
    expect(replay).toMatchObject({
      appendedCount: 0,
      sessionTurnMutationResult: { replayed: true, result: turn.sessionTurnMutationResult?.result },
    });
    expect(counts()).toEqual({ nodes: 1, windows: 1, events: 2, receipts: 1 });
  });

  it.for(["success", "callback failure", "completion failure"] as const)(
    "joins accepted committed work before publication or %s settlement",
    async (mode, test) => {
      const accepted = createDeferred();
      const release = createDeferred();
      const order: string[] = [];
      const failure = new Error(mode);
      const unsubscribe = onSessionTranscriptUpdate((update) => {
        if (update.target.sessionId === sessionId) {
          order.push("published");
        }
      });
      let callbacks = 0;
      const append = admit({
        updateMode: "inline",
        messages: [
          { message: { role: "user", content: operation.objective } },
          { message: { role: "assistant", content: "Committed reply" } },
        ],
        onMessageCommitted: (_receipt, acceptCompletion) => {
          const index = ++callbacks;
          order.push(`accepted:${index}`);
          acceptCompletion(async () => {
            await release.promise;
            order.push(`completed:${index}`);
            if (mode === "completion failure" && index === 1) {
              throw failure;
            }
          });
          if (index === 2) {
            accepted.resolve();
            if (mode === "callback failure") {
              throw failure;
            }
          }
        },
      });
      const outcome = append.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await racePromiseWithAbortSignal(
          Promise.race([
            accepted.promise,
            outcome.then(() => {
              throw new Error("Commit settled before both callbacks accepted work");
            }),
          ]),
          test.signal,
        );
        expect(order).toEqual(["accepted:1", "accepted:2"]);
        release.resolve();
        const result = await outcome;
        if (mode === "success") {
          expect(result).toMatchObject({ value: { appendedCount: 2 } });
          expect(order).toEqual([
            "accepted:1",
            "accepted:2",
            "completed:1",
            "completed:2",
            "published",
            "published",
          ]);
        } else {
          expect(result).toEqual({ error: failure });
          expect(order).toEqual(["accepted:1", "accepted:2", "completed:1", "completed:2"]);
        }
        expect(counts()).toEqual({ nodes: 1, windows: 1, events: 3, receipts: 1 });
      } finally {
        release.resolve();
        await outcome;
        unsubscribe();
      }
    },
  );

  it.each(["competing-session", sessionId])(
    "does not replace %s created during preparation",
    async (competingSessionId) => {
      const competing = { sessionId: competingSessionId, updatedAt: now };
      const turn = await admit({
        messages: [
          {
            message: { role: "user", content: operation.objective },
            shouldAppend: () => {
              // Direct/cross-process writers bypass the process-local queue.
              replaceSessionEntrySync(scope(), competing);
              return true;
            },
          },
        ],
      });
      expect(turn).toMatchObject({ rejectedReason: "session-rebound", appendedCount: 0 });
      expect(loadSessionEntry(scope())).toMatchObject(competing);
      expect(loadSessionEntry(scope())?.goal).toBeUndefined();
      expect(await loadTranscriptEvents(scope())).toEqual([]);
      expect(counts()).toEqual({ nodes: 1, windows: 1, events: 0, receipts: 0 });
    },
  );

  it("rolls back even the session placeholder and header when the receipt cannot commit", async () => {
    database().db.exec(
      `CREATE TRIGGER reject_first_goal_receipt BEFORE INSERT ON session_goal_operations
        BEGIN SELECT RAISE(ABORT, 'first receipt failed'); END;`,
    );
    await expect(admit()).rejects.toThrow("first receipt failed");
    expect(loadSessionEntry(scope())).toBeUndefined();
    expect(counts()).toEqual({ nodes: 0, windows: 0, events: 0, receipts: 0 });
    database().db.exec("DROP TRIGGER reject_first_goal_receipt");
    await expect(admit()).resolves.toMatchObject({ appendedCount: 1 });
  });

  it("does not recreate a deleted session from its retained Goal receipt", async () => {
    await admit();
    await applySessionEntryLifecycleMutation({
      agentId: "main",
      storePath: fixture.storePath(),
      removals: [{ sessionKey: scope().sessionKey }],
      skipMaintenance: true,
    });
    expect(loadSessionEntry(scope())).toBeUndefined();
    const before = counts();
    expect(before).toMatchObject({ receipts: 1 });
    await expect(admit()).resolves.toMatchObject({
      rejectedReason: "session-rebound",
      appendedCount: 0,
    });
    expect(loadSessionEntry(scope())).toBeUndefined();
    expect(counts()).toEqual(before);
  });

  it("keeps first-session creation absent when admission authority closes during preparation", async () => {
    let current = true;
    await expect(
      admit({
        sessionTurnMutation: {
          kind: "goal",
          operation,
          runId: operation.operationId,
          assertCurrent: () => {
            if (!current) {
              throw new Error("admission closed");
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
    ).rejects.toThrow("admission closed");
    expect(counts()).toEqual({ nodes: 0, windows: 0, events: 0, receipts: 0 });
  });
});
