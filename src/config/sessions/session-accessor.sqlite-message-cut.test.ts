import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assert, afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SqliteJsonlReadBudgetExceededError } from "../../infra/sqlite-jsonl-budget-error.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import {
  appendTranscriptEvent as appendEvent,
  appendTranscriptMessage as appendMessage,
  forkSessionAtMessage as fork,
  listSessionBranches as branches,
  listSessionParticipantsReadOnly as participantsFor,
  loadSessionEntry as readEntry,
  loadTranscriptEvents as readEvents,
  readSessionTranscriptMessageEventPage as readPage,
  readSessionTranscriptMessageEvents as readMessages,
  rewindSessionToMessage as rewind,
  switchSessionBranch as switchBranch,
  updateSessionEntry as updateEntry,
  upsertSessionEntryCore as upsertEntry,
} from "./session-accessor.js";
import {
  agentId,
  sessionKey,
  sourceExpectedState,
  useSessionMessageCutFixtures,
} from "./session-accessor.sqlite-message-cut.test-support.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { readTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { prepareSessionTranscriptActivePathRepoint as prepareRepoint } from "./session-transcript-active-path-repoint.js";
import { SYNC_REBUILD_MAX_BYTES } from "./session-transcript-index.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "./session-transcript-reconcile.js";
import type { InternalSessionEntry } from "./types.js";

const { createSession, tempDirs } = useSessionMessageCutFixtures();

async function retainLegacyCheckpoints(
  scope: Parameters<typeof updateEntry>[0] & { sessionId: string },
) {
  const checkpoints = [
    {
      sessionId: scope.sessionId,
      preCompaction: { sessionId: scope.sessionId },
      postCompaction: { sessionId: scope.sessionId },
    },
  ];
  await updateEntry(scope, (entry) => ({ ...entry, compactionCheckpoints: checkpoints }));
  return checkpoints;
}

function expectEditorResult(result: unknown, key: string) {
  expect(result).toMatchObject({
    status: "created",
    key,
    editorText: "second prompt",
    editorAttachments: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
    editorMediaRefs: [{ path: "/state/media/inbound/stored-image.png", contentType: "image/png" }],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("returns missing-session for history navigation in an absent store", async () => {
  const { env } = await createSession();
  const missing = { env, agentId: "absent", sessionKey: "agent:absent:missing" };
  await expect(rewind({ ...missing, entryId: "user-2" })).resolves.toEqual({
    status: "missing-session",
  });
  await expect(switchBranch({ ...missing, leafEntryId: "assistant-2" })).resolves.toEqual({
    status: "missing-session",
  });
  const denied = new Error("Missing-store navigation authority was revoked");
  await expect(
    rewind({
      ...missing,
      entryId: "user-2",
      commitGuard() {
        throw denied;
      },
    }),
  ).rejects.toBe(denied);
});

// Rewind keeps its transcript identity, so the fence that retires pre-rewind
// readers and writers is the rotated transcript generation, not a new session id.
it("rewinds in place and voids the pre-rewind transcript generation", async () => {
  const { env, scope, params } = await createSession();
  const readGeneration = () =>
    readTranscriptGenerationInTransaction(
      openOpenClawAgentDatabase({ agentId, env }),
      scope.sessionId,
    );
  const before = readGeneration();
  const rotatedSessionIds: Array<string | undefined> = [];
  const stop = onSessionIdentityMutation((event) => {
    if (
      event.kind !== "delete" &&
      event.previous.sessionKeys.includes(sessionKey) &&
      event.current.sessionId !== scope.sessionId
    ) {
      rotatedSessionIds.push(event.current.sessionId);
    }
  });
  let result;
  try {
    result = await rewind(params, sourceExpectedState);
  } finally {
    stop();
  }
  assert(result.status === "created");
  expect({
    sessionId: result.entry.sessionId,
    previousSessionId: result.entry.previousSessionId,
    storedSessionId: readEntry(scope)?.sessionId,
    generationRotated: Boolean(before) && readGeneration() !== before,
    rotatedSessionIds,
  }).toEqual({
    sessionId: scope.sessionId,
    previousSessionId: undefined,
    storedSessionId: scope.sessionId,
    generationRotated: true,
    rotatedSessionIds: [],
  });
});

it("refuses a valid physical store replacement before rewind preparation resumes", async () => {
  const { env, scope } = await createSession();
  const database = openOpenClawAgentDatabase({ agentId, env });
  await closeOpenClawAgentDatabaseByPathAsync(database.path);
  const originalPath = `${database.path}.original`;
  const replacementPath = `${database.path}.replacement`;
  fs.copyFileSync(database.path, replacementPath, fs.constants.COPYFILE_EXCL);
  const readStoredState = (pathname: string) => {
    using reader = new DatabaseSync(pathname, { readOnly: true });
    return {
      entries: reader
        .prepare(
          "SELECT session_key, current_session_id, entry_json FROM session_nodes ORDER BY session_key",
        )
        .all(),
      transcripts: reader.prepare("SELECT * FROM transcript_events ORDER BY session_id, seq").all(),
    };
  };
  const before = readStoredState(database.path);
  expect(before.entries).toEqual([
    expect.objectContaining({ session_key: sessionKey, current_session_id: scope.sessionId }),
  ]);
  expect(before.transcripts.length).toBeGreaterThan(0);
  expect(readStoredState(replacementPath)).toEqual(before);

  let originalMoved = false;
  let replacementMoved = false;
  const mutation = rewind({
    ...scope,
    storePath: database.path,
    entryId: "user-2",
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    // No yield: replace the captured physical file before preparation can continue.
    fs.renameSync(database.path, originalPath);
    originalMoved = true;
    fs.renameSync(replacementPath, database.path);
    replacementMoved = true;
    expect(await mutation).toMatchObject({
      error: {
        message: expect.stringMatching(
          /identity changed|physical file|target changed|database.*(?:changed|replaced)/i,
        ),
      },
    });
  } finally {
    try {
      await mutation;
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
    } finally {
      if (replacementMoved) {
        fs.renameSync(database.path, replacementPath);
      }
      if (originalMoved) {
        fs.renameSync(originalPath, database.path);
      }
    }
  }
  expect(readStoredState(database.path)).toEqual(before);
  expect(readStoredState(replacementPath)).toEqual(before);
});

it("drains fixture resources before retiring native handles and removing the root", async ({
  onTestFinished,
}) => {
  const { env } = await createSession();
  const agentDatabase = openOpenClawAgentDatabase({ agentId, env });
  const stateDatabase = openOpenClawStateDatabase({ env });
  const snapshot = () => [
    agentDatabase.db.isOpen,
    stateDatabase.db.isOpen,
    fs.existsSync(env.OPENCLAW_STATE_DIR),
  ];
  const closingSnapshots: boolean[][] = [];
  registerOpenClawAgentDatabaseAsyncResource({
    agentId,
    path: agentDatabase.path,
    revoke: () => {},
    close: async () => {
      await Promise.resolve();
      closingSnapshots.push(snapshot());
    },
  });

  // Inspect real fixture teardown after both consumer and helper afterEach hooks run.
  onTestFinished(() => {
    expect(closingSnapshots).toEqual([[true, true, true]]);
    expect(snapshot()).toEqual([false, false, false]);
  });
});

it.each(["rewind", "fork"] as const)(
  "rejects %s when the source lifecycle changes in the writer queue",
  async (mode) => {
    const { scope, params } = await createSession();
    const ownerChangeGate = createDeferred();
    const ownerChangeStarted = createDeferred();
    const ownerChange = updateEntry(scope, async () => {
      ownerChangeStarted.resolve();
      await ownerChangeGate.promise;
      return { lifecycleRevision: "replacement-lifecycle-revision" };
    });
    await ownerChangeStarted.promise;

    const targetKey = `${sessionKey}:raced-fork`;
    const mutation = mode === "rewind" ? rewind(params) : fork({ ...params, targetKey });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    ownerChangeGate.resolve();

    await ownerChange;
    await expect(mutation).resolves.toEqual({ status: "conflict" });
    expect(readEntry(scope)).toMatchObject({
      lifecycleRevision: "replacement-lifecycle-revision",
      sessionId: sourceExpectedState.sessionId,
    });
    expect(readEntry({ ...params, sessionKey: targetKey })).toBeUndefined();
    await expect(branches(params)).resolves.toMatchObject({
      status: "ok",
      branches: expect.arrayContaining([
        expect.objectContaining({ active: true, leafEntryId: "assistant-2" }),
      ]),
    });
  },
);

it("rewinds by repointing the active leaf and returns the editor text", async () => {
  const { scope, params } = await createSession();
  const legacyCheckpoints = await retainLegacyCheckpoints(scope);

  const canonicalKey = "agent:main:canonical-message-cut";
  const result = await rewind({
    ...params,
    sessionKey: canonicalKey,
    sessionStoreKey: sessionKey,
  });
  assert(result.status === "created");

  expectEditorResult(result, sessionKey);
  expect(
    readPage(
      { agentId, env: scope.env, sessionId: result.entry.sessionId },
      { maxMessages: 0, offset: 0 },
    ).totalMessages,
  ).toBe(2);
  expect(readEntry(params)?.sessionId).toBe(result.entry.sessionId);
  expect(readEntry({ ...params, sessionKey: canonicalKey })).toBeUndefined();
  expect(readEntry(scope)).toHaveProperty("compactionCheckpoints", legacyCheckpoints);
  expect(result.entry).toMatchObject({
    agentHarnessId: undefined,
    claudeCliSessionId: undefined,
    cliSessionBindings: undefined,
    cliSessionIds: undefined,
    compactionCount: undefined,
    transcriptByteCompactionLatch: undefined,
    contextTokens: undefined,
    contextTokensSource: undefined,
    createdVia: "operator",
    createdActor: { type: "human", source: "profile", id: "profile-1" },
    createdAt: 1_000,
    forkSource: { sessionKey: "agent:main:root", sessionId: "root-session" },
    // The rewound session keeps its transcript, so no generation is retired.
    sessionId: "message-cut-source",
  });
  expect(result.entry.previousSessionId).toBeUndefined();
  expect(deliveryContextFromSession(result.entry)).toEqual({
    channel: "telegram",
    to: "chat-123",
    accountId: undefined,
  });
});

// A rewind appends one control row, so the active-path projection is repointed
// incrementally. An oversized transcript must not send history readers through a
// full rebuild, which previously made the next read fail with "rebuilding".
it("repoints an oversized transcript without a rebuilding wait", async () => {
  const { scope, params } = await createSession();
  await appendEvent(scope, {
    type: "oversized-padding",
    padding: "x".repeat(SYNC_REBUILD_MAX_BYTES),
  });

  const result = await rewind(params);
  assert(result.status === "created");
  const targetScope = { ...scope, sessionId: result.entry.sessionId };
  expect(readMessages(targetScope)).toHaveLength(2);
  expect(
    readPage(
      { agentId, env: scope.env, sessionId: result.entry.sessionId },
      {
        maxMessages: 0,
        offset: 0,
      },
    ).totalMessages,
  ).toBe(2);
});

// A selected branch can hold more payload than the projection may hydrate inside
// one transaction. The repoint refuses by retained bytes, not only by row count,
// so a branch of large events cannot materialize inside the shared database
// worker: the streaming reconcile owner publishes it instead.
it("switches to an oversized branch without hydrating it in one transaction", async () => {
  const { env, scope } = await createSession();
  await appendEvent(scope, {
    type: "custom",
    id: "oversized-branch-tip",
    customType: "synthetic",
    parentId: "off-path-user",
    timestamp: "2026-07-18T02:00:00.000Z",
    data: { padding: "x".repeat(SYNC_REBUILD_MAX_BYTES) },
  });

  // The append made the oversized row the active leaf; leave it, then select it
  // again so the repoint has to plan that whole branch back onto the active path.
  const left = await switchBranch({ agentId, env, sessionKey, leafEntryId: "assistant-2" });
  expect(left).toMatchObject({ status: "created" });
  const stateDir = env.OPENCLAW_STATE_DIR as string;
  await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
  const planned = (leafEventId: string) =>
    prepareRepoint(openOpenClawAgentDatabase({ agentId, env }).db, scope.sessionId, leafEventId);
  // The clean projection does plan a small divergence, so the refusal below is
  // the retained-byte bound and not a lagging projection.
  expect(planned("assistant-2")).toBeDefined();
  expect(planned("oversized-branch-tip")).toBeUndefined();
  const switched = await switchBranch({
    agentId,
    env,
    sessionKey,
    leafEntryId: "oversized-branch-tip",
  });

  expect(switched).toMatchObject({ status: "created" });
  assert(switched.status === "created");
  await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
  expect(
    readMessages(scope).flatMap(({ event }) =>
      event && typeof event === "object" && "id" in event ? [event.id] : [],
    ),
  ).toEqual(["user-1", "off-path-user"]);
});

// Older appenders wrote canonical rows with no `parentId` at all. The canonical
// tree hangs such a row off whichever leaf was active when it was written, so
// `u1 -> a1` followed by a parentless `u2` keeps all three on the active path.
// Rewinding u2 must therefore restore a1, which the raw payload parent (null)
// does not name: that selected an empty branch and dropped u1 and a1.
it("rewinds a parentless continuation to its canonical predecessor", async () => {
  const stateDir = tempDirs.make("openclaw-message-cut-parentless-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sessionId = "parentless-continuation";
  const key = "agent:main:parentless-continuation";
  const scope = { agentId, env, sessionId, sessionKey: key };
  const startedAt = Date.parse("2026-07-19T00:00:00.000Z");
  await upsertEntry(scope, {
    sessionId,
    lifecycleRevision: "parentless-revision",
    updatedAt: startedAt,
  });
  await appendEvent(scope, {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date(startedAt).toISOString(),
  });
  await appendMessage(scope, {
    eventId: "u1",
    parentId: null,
    message: { role: "user", content: "first prompt" },
    now: startedAt + 1_000,
  });
  await appendMessage(scope, {
    eventId: "a1",
    parentId: "u1",
    message: { role: "assistant", content: "first answer" },
    now: startedAt + 2_000,
  });
  // Only an older appender produces a canonical row with no `parentId` key, so
  // this one is written through the store's in-transaction append owner.
  runOpenClawAgentWriteTransaction(
    (database) =>
      appendTranscriptEventsInTransaction(database, { ...resolveSqliteScope(scope), sessionId }, [
        {
          type: "message",
          id: "u2",
          timestamp: new Date(startedAt + 3_000).toISOString(),
          message: { role: "user", content: "second prompt" },
        },
      ]),
    toDatabaseOptions(resolveSqliteScope(scope)),
  );
  await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
  const activeIds = () =>
    readMessages(scope).flatMap(({ event }) =>
      event && typeof event === "object" && "id" in event ? [event.id] : [],
    );
  expect(activeIds()).toEqual(["u1", "a1", "u2"]);

  const result = await rewind(
    { agentId, env, sessionKey: key, entryId: "u2" },
    { sessionId, lifecycleRevision: "parentless-revision" },
  );

  expect(result).toMatchObject({ status: "created" });
  assert(result.status === "created");
  expect(result.entry.sessionId).toBe(sessionId);
  expect(activeIds()).toEqual(["u1", "a1"]);
});

it("forks an exact active-path prefix without changing the source", async () => {
  const { scope, params } = await createSession();
  const legacyCheckpoints = await retainLegacyCheckpoints(scope);
  const canonicalSourceKey = "agent:main:canonical-message-cut-source";
  const targetKey = "agent:main:dashboard:message-cut-fork";
  recordSessionParticipant(scope, {
    identity: { type: "profile", id: "source-person" },
    promptedAt: 7,
  });

  const sql = observeHostDataSql();
  let result;
  try {
    result = await fork({
      ...params,
      sessionKey: canonicalSourceKey,
      sessionStoreKey: sessionKey,
      targetKey,
    });
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }

  expectEditorResult(result, targetKey);
  assert(result.status === "created");
  const forkEvents = await readEvents({
    ...scope,
    sessionId: result.entry.sessionId,
    sessionKey: targetKey,
  });
  expect(forkEvents[0]).toMatchObject({ type: "session", version: 3 });
  expect(
    forkEvents.flatMap((event) =>
      event && typeof event === "object" && "id" in event ? [event.id] : [],
    ),
  ).toEqual([result.entry.sessionId, "user-1", "assistant-1"]);
  expect(readEntry(scope)?.sessionId).toBe(scope.sessionId);
  expect(readEntry(scope)).toHaveProperty("compactionCheckpoints", legacyCheckpoints);
  expect(readEntry({ ...params, sessionKey: targetKey })).not.toHaveProperty(
    "compactionCheckpoints",
  );
  const participants = participantsFor(scope);
  expect(participants.get(targetKey)).toBeUndefined();
  expect(participants.get(sessionKey)).toEqual([
    {
      identity: { type: "profile", id: "source-person" },
      contributionCount: 1,
      firstPromptedAt: 7,
      lastPromptedAt: 7,
    },
  ]);
  expect(result.entry.lifecycleRevision).not.toBe("source-lifecycle-revision");
  expect(deliveryContextFromSession(result.entry)).toBeUndefined();
  expect(result.entry.forkedFromParent).toBeUndefined();
  expect(result.entry.createdVia).toBeUndefined();
  expect(result.entry.createdActor).toBeUndefined();
  expect(result.entry.createdAt).toBeUndefined();
  expect((result.entry as InternalSessionEntry).lifecycleRunId).toBeUndefined();
  expect((result.entry as InternalSessionEntry).lastRunId).toBeUndefined();
  expect(result.entry.cliSessionBindings).toBeUndefined();
  expect(result.entry.previousSessionId).toBeUndefined();
  expect(result.entry).toMatchObject({
    parentSessionKey: canonicalSourceKey,
    modelOverride: "gpt-5",
    modelOverrideSource: "user",
    providerOverride: "openai",
  });
  expect(result.entry.forkSource).toEqual({
    sessionKey: canonicalSourceKey,
    sessionId: "message-cut-source",
    entryId: "user-2",
  });
  expect(readEntry(scope)?.lifecycleRevision).toBe("source-lifecycle-revision");
});

it("refuses an oversized history row without changing the session or losing the worker", async () => {
  const { scope, params } = await createSession();
  await appendEvent(scope, {
    type: "custom",
    id: "huge",
    parentId: "assistant-2",
    data: "x".repeat(8 * 1024 * 1024),
  });
  const before = readEntry(scope);
  // Fork is the only cut that still copies history, so the read budget guards it.
  await expect(
    fork({ ...params, targetKey: "agent:main:dashboard:message-cut-oversized" }),
  ).rejects.toBeInstanceOf(SqliteJsonlReadBudgetExceededError);
  expect(readEntry(scope)).toEqual(before);
  await updateEntry(scope, (entry) => ({ ...entry, label: "still writable" }));
  expect(readEntry(scope)?.label).toBe("still writable");
  // An in-place rewind never reads the oversized row, so no budget applies.
  const rewound = await rewind(params);
  expect(rewound.status).toBe("created");
});
