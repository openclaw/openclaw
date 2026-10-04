import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptEvent,
  listSessionEntriesCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as sqliteSessionScope from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../config/sessions/transcript-write-context.js";
import * as transcriptEvents from "../sessions/transcript-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  appendAssistantMirrorMessageByIdentity,
  appendSessionTranscriptMessageByIdentity,
  appendSessionYieldContext,
  formatSessionTranscriptMemoryHitKey,
  readLatestAssistantTextByIdentity,
  readSessionTranscriptEvents,
  readVisibleSessionTranscriptMessageEntries,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
  withSessionTranscriptWriteLock,
  type SessionTranscriptReadParams,
} from "./session-transcript-runtime.js";

describe("session transcript runtime SDK", () => {
  let state: OpenClawTestState;
  let storePath: string;
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-sdk-transcript-", applyEnv: false });
    storePath = state.path("sessions.json");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    await state.cleanup();
  });

  async function createScope(sessionId = "session") {
    const scope = { agentId: "main", sessionId, sessionKey: "agent:main:main", storePath };
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 10 });
    return scope;
  }
  const entries = (scope: SessionTranscriptReadParams) =>
    readVisibleSessionTranscriptMessageEntries(scope);
  const append = (scope: SessionTranscriptReadParams, role: string, content: string) =>
    appendSessionTranscriptMessageByIdentity({ ...scope, message: { role, content } });

  it("appends keyed mirrors, dedupes unkeyed mirrors, and rejects a rebound session", async () => {
    const scope = await createScope();
    for (const idempotencyKey of ["delivery-1", "delivery-2"]) {
      await expect(
        appendAssistantMirrorMessageByIdentity({
          ...scope,
          idempotencyKey,
          deliveryMirror: { kind: "channel-final", sourceMessageId: idempotencyKey },
          text: "visible assistant reply",
        }),
      ).resolves.toMatchObject({ ok: true, messageId: expect.any(String) });
    }
    await expect(readLatestAssistantTextByIdentity(scope)).resolves.toBeUndefined();
    expect(await entries(scope)).toHaveLength(2);
    const unkeyed = await createScope("unkeyed");
    const request = { ...unkeyed, text: "unkeyed assistant reply" };
    const first = await appendAssistantMirrorMessageByIdentity(request);
    expect(first).toMatchObject({ ok: true, messageId: expect.any(String) });
    await expect(appendAssistantMirrorMessageByIdentity(request)).resolves.toEqual(first);
    expect(await entries(unkeyed)).toHaveLength(1);
    await expect(
      appendAssistantMirrorMessageByIdentity({ ...scope, text: "stale reply" }),
    ).resolves.toMatchObject({ ok: false, code: "session-rebound" });
  });

  it("does not append an assistant mirror after cancellation", async () => {
    const scope = await createScope();
    const cancellation = new Error("cancelled by user");
    await expect(
      appendAssistantMirrorMessageByIdentity({
        ...scope,
        signal: AbortSignal.abort(cancellation),
        text: "must not be persisted",
      }),
    ).rejects.toBe(cancellation);
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([]);
  });

  it.each(["assistant mirror", "yield context"])(
    "rejects %s after its admitted writer is superseded",
    async (operation) => {
      const scope = await createScope();
      await upsertSessionEntryCore(scope, {
        activeWriterRunId: "replacement-run",
        lifecycleRevision: "revision-a",
        sessionId: scope.sessionId,
        updatedAt: 10,
      });
      await expect(
        withOwnedSessionTranscriptWrites(
          {
            sessionKey: scope.sessionKey,
            sessionTarget: {
              ...scope,
              expectedLifecycleRevision: "revision-a",
              expectedWriterRunId: "superseded-run",
            },
            withTranscriptWrite: async (run) => await run(),
          },
          async () => {
            if (operation === "yield context") {
              await appendSessionYieldContext({
                ...scope,
                message: "must not be persisted",
                assertCurrent: () => {},
              });
            } else {
              await appendAssistantMirrorMessageByIdentity({
                ...scope,
                idempotencyKey: "superseded:fallback",
                text: "must not be persisted",
              });
            }
          },
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
      await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([]);
    },
  );

  it("rechecks yield settlement authority after waiting for the transcript writer", async () => {
    const scope = await createScope();
    let active = true;
    const stopped = new Error("yield settlement stopped");
    const writerEntered = createDeferredCore();
    const releaseWriter = createDeferredCore();
    const heldWriter = withSessionTranscriptWriteLock(scope, async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
    });
    await writerEntered.promise;
    try {
      const write = appendSessionYieldContext({
        ...scope,
        message: "private continuation",
        assertCurrent: () => {
          if (!active) {
            throw stopped;
          }
        },
      });
      const rejected = expect(write).rejects.toBe(stopped);
      active = false;
      releaseWriter.resolve();
      await heldWriter;
      await rejected;
    } finally {
      releaseWriter.resolve();
      await heldWriter;
    }
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([]);
  });

  it("dedupes unkeyed assistant mirrors against only the visible SQLite branch", async () => {
    const scope = await createScope();
    const active = await append(scope, "assistant", "visible branch reply");
    const inactive = await append(scope, "assistant", "inactive mirror reply");
    assert(active && inactive);
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "select-active",
      parentId: inactive.messageId,
      targetId: active.messageId,
    });
    const result = await appendAssistantMirrorMessageByIdentity({
      ...scope,
      text: "inactive mirror reply",
    });
    assert(result.ok);
    expect(result.messageId).not.toBe(inactive.messageId);
    await expect(readSessionTranscriptEvents(scope)).resolves.toContainEqual(
      expect.objectContaining({ id: inactive.messageId }),
    );
    expect(await entries(scope)).toMatchObject([
      { entryId: active.messageId },
      { entryId: result.messageId },
    ]);
  });

  it("does not dedupe unkeyed assistant mirrors across a later user turn", async () => {
    const scope = await createScope();
    const first = await append(scope, "assistant", "repeatable answer");
    await append(scope, "user", "next question");
    const result = await appendAssistantMirrorMessageByIdentity({
      ...scope,
      text: "repeatable answer",
    });
    assert(first && result.ok);
    expect(result.messageId).not.toBe(first.messageId);
    expect((await entries(scope)).map((entry) => entry.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("publishes assistant mirror updates only for newly appended notified rows", async () => {
    const scope = await createScope();
    const updates: unknown[] = [];
    const off = transcriptEvents.onInternalSessionTranscriptUpdate((update) =>
      updates.push(update),
    );
    try {
      await expect(
        appendAssistantMirrorMessageByIdentity({
          ...scope,
          text: "quiet reply",
          updateMode: "none",
        }),
      ).resolves.toMatchObject({ ok: true, messageId: expect.any(String) });
      expect(updates).toEqual([]);
      const request = { ...scope, idempotencyKey: "mirror-once", text: "notified reply" };
      const first = await appendAssistantMirrorMessageByIdentity(request);
      assert(first.ok);
      await expect(appendAssistantMirrorMessageByIdentity(request)).resolves.toEqual(first);
      expect(updates).toEqual([
        expect.objectContaining({
          messageId: first.messageId,
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
        }),
      ]);
    } finally {
      off();
    }
  });

  it("serializes caller-checked idempotency inside scoped locked appends", async () => {
    const scope = {
      agentId: "main",
      sessionId: "caller-checked-lock-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const steps: string[] = [];
    const firstRead = createDeferredCore();
    const releaseFirst = createDeferredCore();
    const secondQueued = createDeferredCore();
    const enqueueWrite = sqliteSessionScope.runExclusiveSqliteSessionWrite;
    let queuedWrites = 0;
    vi.spyOn(sqliteSessionScope, "runExclusiveSqliteSessionWrite").mockImplementation((...args) => {
      const pending = enqueueWrite(...args);
      // This owner enqueues synchronously; observe contention after delegating to the real queue.
      if (args[2] === "session.transcript.locked-write" && ++queuedWrites === 2) {
        secondQueued.resolve();
      }
      return pending;
    });
    let enteredWrites = 0;
    const appendIfMissing = async () =>
      await withSessionTranscriptWriteLock(scope, async (locked) => {
        // Target preparation can finish out of order before either caller acquires the lock.
        const label = ++enteredWrites === 1 ? "first" : "second";
        steps.push(`${label}:read`);
        const events = await locked.readEvents();
        const alreadyAppended = events.some((event) => {
          const message = (event as { message?: { idempotencyKey?: unknown } }).message;
          return message?.idempotencyKey === "mirror-once";
        });
        if (label === "first") {
          firstRead.resolve();
          await releaseFirst.promise;
        }
        if (!alreadyAppended) {
          await locked.appendMessage({
            idempotencyLookup: "caller-checked",
            message: {
              role: "assistant",
              content: [{ type: "text", text: label }],
              idempotencyKey: "mirror-once",
              timestamp: 1,
            },
          });
        }
        steps.push(`${label}:done`);
      });

    const first = appendIfMissing();
    const second = appendIfMissing();
    const writes = Promise.all([first, second]);
    try {
      await Promise.race([Promise.all([firstRead.promise, secondQueued.promise]), writes]);
      expect(steps).toEqual(["first:read"]);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, second]);
    }
    await writes;

    expect(steps).toEqual(["first:read", "first:done", "second:read", "second:done"]);
    const assistantMessages = (await readSessionTranscriptEvents(scope)).filter((event) => {
      const message = (event as { message?: { role?: unknown } }).message;
      return message?.role === "assistant";
    });
    expect(assistantMessages).toHaveLength(1);
  });

  it("does not publish queued locked updates when the callback throws", async () => {
    const scope = await createScope();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    await expect(
      withSessionTranscriptWriteLock(scope, async (locked) => {
        await locked.appendMessage({
          message: { role: "assistant", content: "durable but failed", timestamp: 1 },
        });
        await locked.publishUpdate({ sessionKey: scope.sessionKey });
        throw new Error("stop before commit");
      }),
    ).rejects.toThrow("stop before commit");
    expect(emitSpy).not.toHaveBeenCalled();
    expect(await entries(scope)).toMatchObject([
      { message: { role: "assistant", content: "durable but failed" } },
    ]);
  });

  it("resolves encoded memory hit keys by agent and opaque session id instead of transcript basename", async () => {
    const scope = await createScope("my-plugin:task/1");
    await upsertSessionEntryCore(scope, {
      sessionFile: state.path("legacy-file-name.jsonl"),
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    const key = formatSessionTranscriptMemoryHitKey(scope);
    expect(key).toBe("transcript:main:my-plugin%3Atask%2F1");
    expect(
      resolveSessionTranscriptMemoryHitKeyToSessionKeys({
        key,
        store: Object.fromEntries(
          listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
        ),
      }),
    ).toEqual([scope.sessionKey]);
  });

  it("can avoid synthetic fallback keys for strict live-store checks", () => {
    const key = formatSessionTranscriptMemoryHitKey({
      agentId: "main",
      sessionId: "deleted-session",
    });
    expect(resolveSessionTranscriptMemoryHitKeyToSessionKeys({ key, store: {} })).toEqual([
      "agent:main:deleted-session",
    ]);
    expect(
      resolveSessionTranscriptMemoryHitKeyToSessionKeys({
        includeSyntheticFallback: false,
        key,
        store: {},
      }),
    ).toEqual([]);
  });
});
