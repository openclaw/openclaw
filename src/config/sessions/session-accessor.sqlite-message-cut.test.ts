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
import { createSessionMessageCutReader as createMessageCutReader } from "./session-message-cut-in-place.kernel.js";
import { SESSION_MESSAGE_CUT_MAX_BYTES } from "./session-message-cut-read.js";
import { prepareSessionTranscriptActivePathRepoint as prepareRepoint } from "./session-transcript-active-path-repoint.js";
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

const activeMessageIds = (scope: Parameters<typeof readMessages>[0]) =>
  readMessages(scope).flatMap(({ event }) =>
    event && typeof event === "object" && "id" in event ? [event.id] : [],
  );

/**
 * Install one stored shape whose canonical navigation is not its raw chain, through
 * the append owner: no async writer produces these shapes today.
 */
async function seedLegacyNavigation(kind: "parentless" | "side-cursor" | "reset-boundary") {
  const stateDir = tempDirs.make(`openclaw-message-cut-${kind}-`);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sessionId = `${kind}-source`;
  const key = `agent:main:${kind}`;
  const scope = { agentId, env, sessionId, sessionKey: key };
  const revision = `${kind}-revision`;
  await upsertEntry(scope, { sessionId, lifecycleRevision: revision, updatedAt: 1 });
  const at = (second: number) =>
    new Date(Date.parse("2026-07-19T00:00:00Z") + second).toISOString();
  const message = (id: string, parentId: string | null | undefined, second: number) => ({
    type: "message",
    ...(parentId === undefined ? {} : { parentId }),
    id,
    timestamp: at(second),
    message: { role: id.startsWith("u") ? "user" : "assistant", content: id },
  });
  const shapes = {
    // u2 has no `parentId` key, so the scanner continues it from the leaf a1.
    parentless: [message("u2", undefined, 3)],
    // A side append moves the cursor, not the leaf: u2 re-parents onto a1.
    "side-cursor": [
      {
        type: "custom",
        id: "s",
        customType: "synthetic",
        appendMode: "side",
        parentId: "u1",
        timestamp: at(2),
        data: {},
      },
      message("u2", "s", 3),
      message("a2", "u2", 4),
    ],
    // A reset taken while b1 was active re-roots navigation: a1 predates it.
    "reset-boundary": [
      message("b1", "u1", 2),
      { type: "reset", id: "r1", parentId: "b1", firstKeptEntryId: "b1", timestamp: at(3) },
      message("u2", "r1", 4),
      message("a2", "u2", 5),
    ],
  }[kind];
  const resolved = resolveSqliteScope(scope);
  runOpenClawAgentWriteTransaction(
    (database) =>
      appendTranscriptEventsInTransaction(database, { ...resolved, sessionId }, [
        message("u1", null, 0),
        message("a1", "u1", 1),
        ...shapes,
      ]),
    toDatabaseOptions(resolved),
  );
  await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
  const canonical = activeMessageIds(scope);
  expect(canonical).toEqual(
    kind === "parentless"
      ? ["u1", "a1", "u2"]
      : [...(kind === "side-cursor" ? ["u1", "a1"] : ["b1"]), "u2", "a2"],
  );
  return { env, scope, key, sessionId, revision, stateDir, canonical };
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

// Rewind keeps its transcript identity, so the fence retiring pre-rewind readers
// and writers is the rotated transcript generation, not a new session id.
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

// Canonical navigation is neither the raw parent chain nor raw child links, and a
// control resolves in file order: a side cursor re-parents u2 onto a1 ([u1,a1,u2,a2],
// not [u1,s,u2,a2]); a parentless u2 continues a1, so a1 is not a tip; after a reset
// a1 predates the boundary, so a control targeting it is rewritten onto the current
// leaf. Selecting a1 refuses, and the projection keeps agreeing with a full rebuild.
it.each(["parentless", "side-cursor", "reset-boundary"] as const)(
  "keeps canonical navigation for a %s history",
  async (kind) => {
    const { env, scope, key, sessionId, revision, stateDir, canonical } =
      await seedLegacyNavigation(kind);
    expect(await switchBranch({ agentId, env, sessionKey: key, leafEntryId: "a1" })).toEqual({
      status: "not-branch-tip",
    });

    const rewound = await rewind(
      { agentId, env, sessionKey: key, entryId: "u2" },
      { sessionId, lifecycleRevision: revision },
    );

    assert(rewound.status === "created", `rewind refused: ${rewound.status}`);
    expect(activeMessageIds(scope)).toEqual(kind === "reset-boundary" ? ["b1"] : ["u1", "a1"]);
    if (kind === "side-cursor") {
      // Switching back must publish what a full canonical rebuild publishes.
      const switched = await switchBranch({ agentId, env, sessionKey: key, leafEntryId: "a2" });
      assert(switched.status === "created", `switch refused: ${switched.status}`);
      await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
      expect(activeMessageIds(scope)).toEqual(canonical);
    }
  },
);

// A rewind repoints incrementally, so oversized history must not send readers
// through a full rebuild (which failed reads with "rebuilding"); the repoint also
// refuses by retained bytes, so a large branch never materializes in the worker.
it("repoints oversized history without hydrating it in one transaction", async () => {
  const { env, scope, params } = await createSession();
  // An oversized stored user turn: navigation never decodes it; the editor read
  // refuses it by budget.
  await appendMessage(scope, {
    eventId: "oversized-branch-tip",
    parentId: "off-path-user",
    message: { role: "user", content: "x".repeat(SESSION_MESSAGE_CUT_MAX_BYTES) },
    now: Date.parse("2026-07-18T02:00:00.000Z"),
  });

  // The append made the oversized row the active leaf; leave it, then select it so
  // the repoint must plan that branch back onto the active path.
  const select = (leafEntryId: string) => switchBranch({ agentId, env, sessionKey, leafEntryId });
  const stateDir = env.OPENCLAW_STATE_DIR as string;
  expect(await select("assistant-2")).toMatchObject({ status: "created" });
  const rewound = await rewind({ ...params, entryId: "user-2" });
  assert(rewound.status === "created", `rewind refused: ${rewound.status}`);
  const target = { agentId, env, sessionId: rewound.entry.sessionId };
  expect(readPage(target, { maxMessages: 0, offset: 0 }).totalMessages).toBe(2);
  expect(await select("assistant-2")).toMatchObject({ status: "created" });
  await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
  // Through the production reader: the clean projection plans a small divergence,
  // so the oversized refusal below is the byte bound, not a lagging projection.
  const database = openOpenClawAgentDatabase({ agentId, env });
  const reader = createMessageCutReader(database, scope.sessionId);
  const planned = (leafEventId: string) =>
    prepareRepoint(database.db, scope.sessionId, leafEventId, (leafId) =>
      reader.canonicalBranchPathSeqs?.(leafId),
    );
  expect(planned("assistant-2")).toBeDefined();
  expect(planned("oversized-branch-tip")).toBeUndefined();

  // A switch needs navigation facts only, so it succeeds over the oversized row,
  // and only a rewind reads that payload, after validating the selection.
  expect(await select("oversized-branch-tip")).toMatchObject({ status: "created" });
  await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
  expect(activeMessageIds(scope)).toEqual(["user-1", "off-path-user", "oversized-branch-tip"]);
  await expect(rewind({ ...params, entryId: "oversized-branch-tip" })).rejects.toThrow(
    /read budget/,
  );
});

// The lifecycle revision is the fence that retires a live writer holding pre-rewind
// state: without it an owner-fenced append resurrects the branch the cut left.
it("fences a live writer that holds the pre-rewind incarnation", async () => {
  const { scope, params } = await createSession();
  const before = readEntry(scope);
  assert(before);
  // Captured by a live SessionManager before the cut.
  const staleOwner = { lifecycleRevision: before.lifecycleRevision };
  const result = await rewind(params);
  assert(result.status === "created");
  expect(result.entry.sessionId).toBe(scope.sessionId);
  expect(result.entry.lifecycleRevision).not.toBe(before.lifecycleRevision);

  await expect(
    appendMessage(
      { ...scope, expectedOwner: staleOwner },
      {
        eventId: "stale-assistant",
        message: { role: "assistant", content: "resurrected tail" },
        parentId: "assistant-2",
      },
    ),
  ).rejects.toThrow("session writer claim changed before transcript persistence");

  // The repoint survives and the stale event never reached the transcript.
  expect(activeMessageIds(scope)).toEqual(["user-1", "assistant-1"]);
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
