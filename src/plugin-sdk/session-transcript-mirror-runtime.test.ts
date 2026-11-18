import assert from "node:assert/strict";
import path from "node:path";
import { afterAll, beforeEach, expect, it } from "vitest";
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

let storePath: string;

beforeEach(() => {
  storePath = path.join(sessionDirs.make(), "sessions.json");
});

function target(name: string) {
  const sessionId = `${name}-session`,
    sessionKey = `agent:main:${name}`;
  return { agentId: "main", sessionId, sessionKey, storePath };
}
async function seed(name: string) {
  const scope = target(name);
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  return scope;
}
function message(role: string, text: string, idempotencyKey: string, timestamp: number) {
  return { role, content: [{ type: "text", text }], idempotencyKey, timestamp };
}
const userFacts = {
  existingIdempotencyKeys: new Set(["mirror-user"]),
  messagesByIdempotencyKey: new Map([["mirror-user", expect.objectContaining({ role: "user" })]]),
};
type Append = { result?: unknown; messageSeq?: number };
function expectAppend(value: Append, role: string, seq?: number) {
  expect(value.result).toMatchObject({ appended: true, message: { role } });
  expect(value.messageSeq).toBe(seq);
}

it("rechecks idempotency and publishes only committed visible sequences", async () => {
  const scope = await seed("indexed-mirror");

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
    expectAppend(first, "user", 1);
    expect(await locked.readMessageFacts({ idempotencyKeys: ["mirror-user"] })).toMatchObject(
      userFacts,
    );
    const replay = await locked.appendMessageWithMessageSequence({
      idempotencyLookup: "scan",
      message: message("user", "persist once", "mirror-user", 2),
    });
    expect(replay.result).toMatchObject({
      appended: false,
      message: { content: [{ text: "persist once", type: "text" }], role: "user" },
    });
    expect(replay.messageSeq).toBeUndefined();

    assert(first.result, "expected initial mirror append");
    await locked.appendMessage({
      message: message("assistant", "abandoned branch", "mirror-abandoned", 3),
      parentId: first.result.messageId,
    });
    const activeBranch = await locked.appendMessageWithMessageSequence({
      message: message("assistant", "final active branch", "mirror-active", 4),
      parentId: first.result.messageId,
    });
    expectAppend(activeBranch, "assistant");
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
    expectAppend(afterReconcile, "assistant", 3);
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
    expectAppend(dirtyProjection, "assistant");
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
  const sessionTarget = {
    ...scope,
    expectedLifecycleRevision: entry.lifecycleRevision,
    expectedWriterRunId: entry.activeWriterRunId,
  };
  const reply = { role: "assistant", content: "Committed reply" };
  const append = () =>
    withCodexSessionTranscriptMirrorWriteLock(scope, (locked) =>
      locked.appendMessageWithMessageSequence({ message: reply }),
    );
  const appended = await withOwnedSessionTranscriptWrites(
    { sessionTarget, withTranscriptWrite: async (run) => run() },
    append,
  );
  expect(appended).toMatchObject({ lifecycleRevision: entry.lifecycleRevision, messageSeq: 1 });
  const result = appended.result;
  assert(result, "expected committed mirror reply");
  await upsertSessionEntryCore(scope, { ...entry, lifecycleRevision: "replacement-lifecycle" });
  const internalUpdates: InternalSessionTranscriptUpdate[] = [];
  const publicUpdates: SessionTranscriptUpdate[] = [];
  using subscriptions = new DisposableStack();
  subscriptions.defer(onInternalSessionTranscriptUpdate((update) => internalUpdates.push(update)));
  subscriptions.defer(onSessionTranscriptUpdate((update) => publicUpdates.push(update)));
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
});

it("rejects an admission receipt for a different transcript target", async () => {
  const admittedScope = await seed("admitted");
  const requestedScope = await seed("requested");
  const admitted = await appendSessionTranscriptMessageByIdentity({
    ...admittedScope,
    message: { role: "user", content: "admitted elsewhere" },
  });
  assert(admitted?.anchor, "expected admitted transcript anchor");

  const admission = { ...admitted.anchor, logicalTurnId: "admitted-turn", role: "user" as const };
  await expect(
    readCodexSessionTranscriptEventsBeforeAdmission(requestedScope, admission),
  ).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);
});
