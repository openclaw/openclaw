import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { lookupSessionGoalOperation } from "../config/sessions/goals-operations-read.js";
import { mutateSessionGoal } from "../config/sessions/goals-operations.js";
import { getSessionGoal } from "../config/sessions/goals.js";
import { trimTranscriptForManualCompact } from "../config/sessions/session-accessor.sqlite-compaction.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withTranscriptWriteSequence } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import { trimSessionTranscriptForManualCompact } from "../config/sessions/session-accessor.transcript.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "../config/sessions/session-message-rewrite.js";
import { withPreparedTranscriptCorrection } from "../config/sessions/session-transcript-correction.js";
import { appendPreparedTranscriptEvent } from "../config/sessions/session-transcript-event.js";
import { loadTranscriptEvents } from "../config/sessions/session-transcript-events.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  registerIncognitoMutationAdmissionTests,
  type IncognitoMutationFixture,
} from "./openclaw-agent-execution-incognito.mutation-admission.test-support.js";
import { registerIncognitoSdkMutationTests } from "./openclaw-agent-execution-incognito.sdk-mutations.test-support.js";
import { useIncognitoNoHostSql } from "./openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

export function registerIncognitoSessionMutationTests(
  getFixture: () => IncognitoMutationFixture,
): void {
  registerIncognitoMutationAdmissionTests(getFixture);

  it("commits actor Goal management and receipts together without replaying an earlier edit", async () => {
    const { actor, authority, key, entry } = getFixture();
    const sessionKey = key("goal-management");
    const sessionId = "goal-management";
    const now = Date.now();
    await actor.sessions.create(authority, {
      sessionKey,
      entry: {
        ...entry(sessionId),
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "original",
          status: "active",
          createdAt: now,
          updatedAt: now,
          tokenStart: 0,
          tokensUsed: 0,
          continuationTurns: 0,
        },
      },
    });
    await withIncognitoSessionActor(actor, async () => {
      const sql = observeMainThreadSql();
      try {
        const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
        const operation = {
          action: "edit" as const,
          goalId: "goal-1",
          objective: "literal café 🦞\ntext",
          operationId: "edit-1",
          issuedAtMs: now,
          requestFingerprint: "edit-1",
        };
        const input = { ...scope, expectedSessionId: sessionId, operation };
        const edited = await mutateSessionGoal(input);
        expect(edited).toMatchObject({
          replayed: false,
          result: { goal: { objective: operation.objective } },
        });
        expect(await lookupSessionGoalOperation(input)).toEqual(edited.result);
        await mutateSessionGoal({
          ...input,
          operation: {
            action: "pause",
            goalId: "goal-1",
            operationId: "pause-1",
            issuedAtMs: now,
            requestFingerprint: "pause-1",
          },
        });
        expect(await mutateSessionGoal(input)).toEqual({ replayed: true, result: edited.result });
        await expect(
          mutateSessionGoal({
            ...input,
            operation: { ...operation, objective: "conflicting retry" },
          }),
        ).rejects.toThrow("already used for a different request");
        expect(await getSessionGoal({ ...scope, persist: false })).toMatchObject({
          status: "found",
          goal: { status: "paused", objective: operation.objective },
        });
        await expect(
          mutateSessionGoal({ ...input, sessionKey: key("absent-goal") }),
        ).rejects.toThrow("Session changed");
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    });
  });

  it("trims actor maxLines and invalidates its token and CLI metadata in the same commit", async () => {
    const { actor, authority, key, entry } = getFixture();
    const sessionKey = key("manual-compact");
    const sessionId = "manual-compact";
    await actor.sessions.create(authority, {
      sessionKey,
      entry: {
        ...entry(sessionId),
        totalTokens: 90,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        inputTokens: 40,
        cliSessionIds: { codex: "stale-cli" },
      },
    });
    await withIncognitoSessionActor(actor, async () => {
      const sql = observeMainThreadSql();
      try {
        const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
        for (const content of ["first", "second", "last"]) {
          await actor.sessions.transcript(authority, {
            type: "session.message.append",
            input: { sessionKey, sessionId, fence: {}, message: { role: "user", content } },
          });
        }
        expect(
          await trimSessionTranscriptForManualCompact(scope, { maxLines: 2, nowMs: 50_000 }),
        ).toEqual({ compacted: true, kept: 2 });
        expect(await loadTranscriptEvents(scope)).toMatchObject([
          { type: "session", id: sessionId },
          { type: "message", parentId: null, message: { content: "last" } },
        ]);
        const updated = (await actor.sessions.read(authority, { sessionKey })).entry;
        expect(updated?.updatedAt).toBe(50_000);
        for (const field of [
          "totalTokens",
          "totalTokensFresh",
          "totalTokensVersion",
          "inputTokens",
          "cliSessionIds",
        ] as const) {
          expect(updated?.[field]).toBeUndefined();
        }
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    });
  });

  it("refuses an actor manual trim when a queued append changes the selected transcript", async () => {
    const { actor, authority, key, entry } = getFixture();
    const sessionKey = key("manual-compact-cas");
    const sessionId = "manual-compact-cas";
    await actor.sessions.create(authority, { sessionKey, entry: entry(sessionId) });
    await withIncognitoSessionActor(actor, async () => {
      const sql = observeMainThreadSql();
      const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
      let append: Promise<unknown> | undefined;
      try {
        await expect(
          trimTranscriptForManualCompact(scope, (lines) => {
            append = actor.sessions.transcript(authority, {
              type: "session.message.append",
              input: {
                sessionKey,
                sessionId,
                fence: {},
                message: { role: "user", content: "accepted after selection" },
              },
            });
            return lines.slice(0, 1);
          }),
        ).rejects.toThrow("SQLite transcript changed while preparing rewrite");
        await append;
        expect(await loadTranscriptEvents(scope)).toMatchObject([
          { type: "session", id: sessionId },
          { type: "message", message: { content: "accepted after selection" } },
        ]);
        sql.expectIdle();
      } finally {
        await append;
        sql.restore();
      }
    });
  });

  it("persists actor turns with original replay bytes and rejects a replaced lifecycle", async () => {
    const { actor, authority, key, entry } = getFixture();
    const sessionKey = key("typed-turn");
    const sessionId = "typed-turn";
    await actor.sessions.create(authority, { sessionKey, entry: entry(sessionId) });
    await withIncognitoSessionActor(actor, async () => {
      const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
      const prepare = vi.fn(async () => ({
        role: "assistant",
        idempotencyKey: "typed-answer",
        content: "literal café 🦞\ntext",
      }));
      const options = {
        config: {},
        expectedSessionId: sessionId,
        expectedLifecycleRevision: "initial",
        updateMode: "none" as const,
        touchSessionEntry: true,
        messages: [
          {
            eventId: "typed-answer",
            message: { role: "assistant", content: "draft", idempotencyKey: "typed-answer" },
            workerPreparation: { prepareMessageAfterIdempotencyCheckAsync: prepare },
          },
        ],
      };
      const sql = observeMainThreadSql();
      try {
        const first = await persistSessionTranscriptTurn(scope, options);
        expect(first).toMatchObject({
          appendedCount: 1,
          messages: [{ messageId: "typed-answer", message: { content: "literal café 🦞\ntext" } }],
        });
        const replay = await persistSessionTranscriptTurn(scope, options);
        expect(replay).toMatchObject({
          appendedCount: 0,
          messages: [
            { appended: false, messageId: "typed-answer", message: first.messages[0]!.message },
          ],
        });
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(
          await persistSessionTranscriptTurn(scope, {
            ...options,
            expectedLifecycleRevision: "replaced",
          }),
        ).toMatchObject({ appendedCount: 0, rejectedReason: "session-rebound" });
        const events = await loadTranscriptEvents(scope);
        expect(events).toHaveLength(2);
        expect(events[1]).toMatchObject({
          id: "typed-answer",
          message: { content: "literal café 🦞\ntext" },
        });
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    });
  });

  it("rewrites and corrects actor transcript rows while preserving neighboring events", async () => {
    const { actor, authority, key, entry, env } = getFixture();
    const sessionKey = key("typed-rewrite");
    const sessionId = "typed-rewrite";
    await actor.sessions.create(authority, { sessionKey, entry: entry(sessionId) });
    const borrower = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: actor.agentId,
      env,
      authority,
      existingOnly: true,
    });
    assert(borrower);
    expect(borrower.identity).toEqual(actor.identity);
    const external = new AsyncResource("incognito-correction-callback");
    const failure = new Error("correction callback failed");
    let releasing: Promise<void> | undefined;
    await withIncognitoSessionActor(actor, async () => {
      const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
      const sql = observeMainThreadSql();
      try {
        const turn = await persistSessionTranscriptTurn(scope, {
          config: {},
          expectedSessionId: sessionId,
          updateMode: "none",
          messages: [
            { eventId: "rewrite-answer", message: { role: "assistant", content: "original" } },
          ],
        });
        const anchor = turn.messages[0]?.anchor;
        assert(anchor);
        await appendPreparedTranscriptEvent(
          scope,
          {
            type: "custom",
            id: "rewrite-note",
            customType: "proof",
            data: { text: "original note" },
          },
          () => {},
        );
        const before = await loadTranscriptEvents(scope);
        const changed = await rewritePreparedTranscriptMessageAtAnchor(anchor, () => ({
          role: "assistant",
          content: "rewritten answer",
        }));
        expect(changed).toMatchObject({
          messageId: "rewrite-answer",
          message: { content: "rewritten answer" },
        });
        let retained:
          | Parameters<Parameters<typeof withPreparedTranscriptCorrection>[1]>[0]
          | undefined;
        let accepted: Promise<void> | undefined;
        let settled = false;
        await expect(
          withIncognitoSessionBinding({ actor: borrower }, () =>
            withPreparedTranscriptCorrection(scope, async (context) => {
              retained = context;
              const events = await context.readEvents();
              releasing = borrower.release();
              accepted = external
                .runInAsyncScope(() =>
                  context.replaceEvents(
                    events.map((event) => {
                      if (
                        typeof event === "object" &&
                        event !== null &&
                        "id" in event &&
                        event.id === "rewrite-note"
                      ) {
                        return Object.assign({}, event, { data: { text: "corrected note" } });
                      }
                      return event;
                    }),
                  ),
                )
                .then(() => {
                  settled = true;
                });
              throw failure;
            }),
          ),
        ).rejects.toBe(failure);
        await releasing;
        expect(settled).toBe(true);
        assert(retained);
        await expect(retained.readEvents()).rejects.toThrow("context is closed");
        await expect(retained.replaceEvents([])).rejects.toThrow("context is closed");
        await accepted;
        const after = await loadTranscriptEvents(scope);
        expect(after[0]).toEqual(before[0]);
        expect(after[1]).toMatchObject({
          id: "rewrite-answer",
          message: { content: "rewritten answer" },
        });
        expect(after[2]).toMatchObject({ id: "rewrite-note", data: { text: "corrected note" } });
        sql.expectIdle();
      } finally {
        external.emitDestroy();
        await borrower.release();
        sql.restore();
      }
    });
  });

  it("refuses a prepared actor turn after a concurrent append without replaying preparation", async () => {
    const { actor, authority, key, entry } = getFixture();
    const sessionKey = key("typed-turn-cas");
    const sessionId = "typed-turn-cas";
    await actor.sessions.create(authority, { sessionKey, entry: entry(sessionId) });
    await withIncognitoSessionActor(actor, async () => {
      const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
      const prepare = vi.fn(async (message: unknown) => {
        await actor.sessions.transcript(authority, {
          type: "session.message.append",
          input: {
            sessionKey,
            sessionId,
            fence: {},
            message: { role: "user", content: "concurrent" },
          },
        });
        return message;
      });
      const sql = observeMainThreadSql();
      try {
        await expect(
          persistSessionTranscriptTurn(scope, {
            config: {},
            expectedSessionId: sessionId,
            updateMode: "none",
            messages: [
              {
                eventId: "stale-turn",
                message: { role: "assistant", content: "stale" },
                workerPreparation: { prepareMessageAfterIdempotencyCheckAsync: prepare },
              },
            ],
          }),
        ).rejects.toThrow("SQLite transcript changed while preparing rewrite");
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(await loadTranscriptEvents(scope)).toMatchObject([
          { type: "session" },
          { type: "message", message: { content: "concurrent" } },
        ]);
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    });
  });

  describe("SDK transcript mutations", () => {
    useIncognitoNoHostSql();
    registerIncognitoSdkMutationTests(getFixture);
  });

  it.each(["explicit", "inherited"] as const)(
    "refuses an event after its %s writer fence is revoked",
    async (mode) => {
      const { actor, authority, key, entry } = getFixture();
      const sessionId = `event-revoked-${mode}`;
      const sessionKey = key(sessionId);
      const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
      const owner = { lifecycleRevision: "initial", activeWriterRunId: "first" };
      const fenced = {
        ...scope,
        expectedLifecycleRevision: owner.lifecycleRevision,
        expectedWriterRunId: owner.activeWriterRunId,
        expectedOwner: owner,
      };
      await actor.sessions.create(authority, {
        sessionKey,
        entry: entry(sessionId),
      });
      await withIncognitoSessionActor(actor, async () => {
        const sql = observeMainThreadSql();
        try {
          await patchSessionEntryCore(scope, () => ({ activeWriterRunId: "first" }));
          await patchSessionEntryCore(scope, () => ({ activeWriterRunId: "successor" }));
          const append = () =>
            appendPreparedTranscriptEvent(
              mode === "explicit" ? fenced : scope,
              {
                type: "custom",
                id: "revoked-event",
                customType: "proof",
                data: { text: "must not persist" },
              },
              () => {},
            );
          await expect(
            mode === "explicit"
              ? append()
              : withOwnedSessionTranscriptWrites(
                  { sessionTarget: fenced, withTranscriptWrite: async (run) => await run() },
                  append,
                ),
          ).rejects.toThrow(/changed|rebound|writer/i);
          expect(await loadTranscriptEvents(scope)).toEqual([
            expect.objectContaining({ type: "session", id: sessionId }),
          ]);
          sql.expectIdle();
        } finally {
          sql.restore();
        }
      });
    },
  );

  it("retains an explicitly absent writer through sequence reads, replacements, and appends", async () => {
    const { actor, authority, key, entry } = getFixture();
    const sessionId = "sequence-owner-absence";
    const sessionKey = key(sessionId);
    const scope = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId };
    await actor.sessions.create(authority, { sessionKey, entry: entry(sessionId) });
    await withIncognitoSessionActor(actor, async () => {
      const sql = observeMainThreadSql();
      try {
        await withTranscriptWriteSequence(
          {
            ...scope,
            expectedOwner: { lifecycleRevision: "initial", activeWriterRunId: undefined },
          },
          async (write) => {
            const events = await write.readEvents();
            await patchSessionEntryCore(scope, () => ({ activeWriterRunId: "successor" }));
            await expect(write.replaceEvents(events)).rejects.toThrow(/changed|rebound|writer/i);
            await expect(
              write.appendMessage({ message: { role: "assistant", content: "must not persist" } }),
            ).rejects.toThrow(/changed|rebound|writer/i);
          },
        );
        expect(await loadTranscriptEvents(scope)).toEqual([
          expect.objectContaining({ type: "session", id: sessionId }),
        ]);
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    });
  });

  it("refuses an explicit JavaScript null correction fence instead of adopting the current lifecycle", async () => {
    const { actor, authority, key, entry } = getFixture();
    const sessionId = "correction-null-fence";
    const sessionKey = key(sessionId);
    await actor.sessions.create(authority, { sessionKey, entry: entry(sessionId) });
    await withIncognitoSessionActor(actor, async () => {
      const sql = observeMainThreadSql();
      const consume = vi.fn(async () => undefined);
      try {
        // JavaScript callers can supply null even though the typed writer scope excludes it.
        await expect(
          Reflect.apply(withPreparedTranscriptCorrection, undefined, [
            {
              agentId: actor.agentId,
              storePath: actor.path,
              sessionKey,
              sessionId,
              expectedLifecycleRevision: null,
            },
            consume,
          ]),
        ).rejects.toThrow("writer claim changed");
        expect(consume).not.toHaveBeenCalled();
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    });
  });
}
