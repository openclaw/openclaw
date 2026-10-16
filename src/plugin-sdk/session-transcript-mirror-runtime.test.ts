import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  runExclusiveSqliteSessionWrite,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import {
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  readCodexSessionTranscriptEventsBeforeAdmission,
  withCodexSessionTranscriptMirrorWriteLock,
} from "./codex-session-transcript-runtime.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptVisibleMessageDelta,
} from "./session-transcript-runtime.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-transcript-mirror-");

describe("private session transcript mirror runtime", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = path.join(sessionDirs.make(), "sessions.json");
  });

  const target = (name: string) => ({
    agentId: "main",
    sessionId: `${name}-session`,
    sessionKey: `agent:main:${name}`,
    storePath,
  });
  const message = (role: string, text: string, idempotencyKey: string, timestamp: number) => ({
    role,
    content: [{ type: "text", text }],
    idempotencyKey,
    timestamp,
  });
  const userFacts = {
    existingIdempotencyKeys: new Set(["mirror-user"]),
    messagesByIdempotencyKey: new Map([["mirror-user", expect.objectContaining({ role: "user" })]]),
  };

  it("rechecks idempotency and publishes only committed visible sequences", async () => {
    const scope = target("indexed-mirror");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });

    await withCodexSessionTranscriptMirrorWriteLock(scope, async (locked) => {
      expect(await locked.readMessageFacts({ idempotencyKeys: ["mirror-user"] })).toEqual({
        anchorsByIdempotencyKey: new Map(),
        existingIdempotencyKeys: new Set(),
        messagesByIdempotencyKey: new Map(),
      });
      const first = await locked.appendMessageWithMessageSequence({
        idempotencyLookup: "scan",
        message: message("user", "persist once", "mirror-user", 1),
      });
      expect(first).toMatchObject({
        messageSeq: 1,
        result: { appended: true, message: { role: "user" } },
      });
      expect(await locked.readMessageFacts({ idempotencyKeys: ["mirror-user"] })).toMatchObject(
        userFacts,
      );
      const replay = await locked.appendMessageWithMessageSequence({
        idempotencyLookup: "scan",
        message: message("user", "persist once", "mirror-user", 2),
      });
      expect(replay).toMatchObject({
        result: {
          appended: false,
          message: { content: [{ text: "persist once", type: "text" }], role: "user" },
        },
      });
      expect(replay.messageSeq).toBeUndefined();

      if (!first.result) {
        throw new Error("expected initial mirror append");
      }
      await locked.appendMessage({
        message: message("assistant", "abandoned branch", "mirror-abandoned", 3),
        parentId: first.result.messageId,
      });
      const activeBranch = await locked.appendMessageWithMessageSequence({
        message: message("assistant", "final active branch", "mirror-active", 4),
        parentId: first.result.messageId,
      });
      expect(activeBranch).toMatchObject({
        result: { appended: true, message: { role: "assistant" } },
      });
      expect(activeBranch.messageSeq).toBeUndefined();
    });

    const resolvedScope = resolveSqliteTranscriptScope(scope);
    await waitForSessionTranscriptProjection(scope);
    await expect(
      readSessionTranscriptVisibleMessageDelta({ ...scope, maxMessages: 10 }),
    ).resolves.toMatchObject({
      kind: "page",
      entries: [
        { idempotencyKey: "mirror-user", seq: 1 },
        { idempotencyKey: "mirror-active", seq: 2 },
      ],
      hasMore: false,
    });
    await withCodexSessionTranscriptMirrorWriteLock(scope, async (locked) => {
      const afterReconcile = await locked.appendMessageWithMessageSequence({
        message: message("assistant", "after active branch", "mirror-after-reconcile", 5),
      });
      expect(afterReconcile).toMatchObject({
        messageSeq: 3,
        result: { appended: true, message: { role: "assistant" } },
      });
    });
    await waitForSessionTranscriptProjection(scope);

    await runExclusiveSqliteSessionWrite(
      resolvedScope,
      async () => {
        runOpenClawAgentWriteTransaction((database) => {
          database.db
            .prepare(
              "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
            )
            .run(scope.sessionId);
        }, toDatabaseOptions(resolvedScope));
      },
      "session.transcript.batch",
    );

    await withCodexSessionTranscriptMirrorWriteLock(scope, async (locked) => {
      expect(await locked.readMessageFacts({ idempotencyKeys: ["mirror-user"] })).toMatchObject(
        userFacts,
      );
      const dirtyProjection = await locked.appendMessageWithMessageSequence({
        idempotencyLookup: "scan",
        message: message("assistant", "projection fallback", "mirror-dirty", 6),
      });
      expect(dirtyProjection).toMatchObject({
        result: { appended: true, message: { role: "assistant" } },
      });
      expect(dirtyProjection.messageSeq).toBeUndefined();
    });
  });

  it("publishes the append's lifecycle after the session row is replaced", async () => {
    const scope = target("owned-mirror");
    const entry = {
      sessionId: scope.sessionId,
      activeWriterRunId: "mirror-writer",
      lifecycleRevision: "committed-lifecycle",
      updatedAt: 1,
    };
    await upsertSessionEntryCore(scope, entry);
    const appended = await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: {
          ...scope,
          expectedLifecycleRevision: entry.lifecycleRevision,
          expectedWriterRunId: entry.activeWriterRunId,
        },
        withTranscriptWrite: async (run) => await run(),
      },
      () =>
        withCodexSessionTranscriptMirrorWriteLock(scope, (locked) =>
          locked.appendMessageWithMessageSequence({
            message: { role: "assistant", content: "Committed reply" },
          }),
        ),
    );
    expect(appended.lifecycleRevision).toBe(entry.lifecycleRevision);
    expect(appended.messageSeq).toBe(1);
    const result = appended.result;
    if (!result) {
      throw new Error("expected committed mirror reply");
    }
    await upsertSessionEntryCore(scope, { ...entry, lifecycleRevision: "replacement-lifecycle" });
    const internalUpdates: InternalSessionTranscriptUpdate[] = [];
    const publicUpdates: SessionTranscriptUpdate[] = [];
    const offInternal = onInternalSessionTranscriptUpdate((update) => internalUpdates.push(update));
    const offPublic = onSessionTranscriptUpdate((update) => publicUpdates.push(update));
    try {
      await withCodexSessionTranscriptMirrorWriteLock(scope, (locked) =>
        locked.publishUpdate({
          lifecycleRevision: appended.lifecycleRevision,
          message: result.message,
          messageId: result.messageId,
          messageSeq: appended.messageSeq,
        }),
      );
      expect(internalUpdates).toMatchObject([
        {
          lifecycleRevision: "committed-lifecycle",
          messageId: result.messageId,
          messageSeq: 1,
        },
      ]);
      expect(publicUpdates).toHaveLength(1);
      expect(publicUpdates[0]).not.toHaveProperty("lifecycleRevision");
    } finally {
      offInternal();
      offPublic();
    }
  });

  it("rejects an admission receipt for a different transcript target", async () => {
    const admittedScope = target("admitted");
    const requestedScope = target("requested");
    await upsertSessionEntryCore(admittedScope, {
      sessionId: admittedScope.sessionId,
      updatedAt: 1,
    });
    await upsertSessionEntryCore(requestedScope, {
      sessionId: requestedScope.sessionId,
      updatedAt: 1,
    });
    const admitted = await appendSessionTranscriptMessageByIdentity({
      ...admittedScope,
      message: { role: "user", content: "admitted elsewhere" },
    });
    if (!admitted?.anchor) {
      throw new Error("expected admitted transcript anchor");
    }

    await expect(
      readCodexSessionTranscriptEventsBeforeAdmission(requestedScope, {
        ...admitted.anchor,
        logicalTurnId: "admitted-turn",
        role: "user",
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);
  });
});
