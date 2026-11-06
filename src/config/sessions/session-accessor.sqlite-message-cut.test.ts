import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assert, afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { canReadSessionAccess } from "./session-access.js";
import {
  appendTranscriptEvent as appendEvent,
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
} from "./session-accessor.js";
import {
  agentId,
  sessionKey,
  sourceExpectedState,
  useSessionMessageCutFixtures,
} from "./session-accessor.sqlite-message-cut.test-support.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { SYNC_REBUILD_MAX_BYTES } from "./session-transcript-index.js";
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";
import type { InternalSessionEntry } from "./types.js";

const { createSession } = useSessionMessageCutFixtures();

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

it("returns a committed rewind after identity publication retires its old authority", async () => {
  const { scope, params } = await createSession();
  let current = true;
  const stop = onSessionIdentityMutation((event) => {
    if (
      event.kind !== "delete" &&
      event.previous.sessionKeys.includes(sessionKey) &&
      event.current.sessionId !== scope.sessionId
    ) {
      current = false;
    }
  });
  try {
    const result = await rewind(
      {
        ...params,
        commitGuard() {
          if (!current) {
            throw new Error("The old session authority ended after publication");
          }
        },
      },
      sourceExpectedState,
    );
    expect({ status: result.status, current, entry: readEntry(scope) }).toMatchObject({
      status: "created",
      current: false,
      entry: { previousSessionId: scope.sessionId },
    });
  } finally {
    stop();
  }
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
    previousSessionId: "message-cut-source",
  });
  expect(deliveryContextFromSession(result.entry)).toEqual({
    channel: "telegram",
    to: "chat-123",
    accountId: undefined,
  });
});

it("defers an oversized rewind projection until the reconcile worker finishes", async () => {
  const { scope, params } = await createSession();
  await appendEvent(scope, {
    type: "oversized-padding",
    padding: "x".repeat(SYNC_REBUILD_MAX_BYTES),
  });

  const result = await rewind(params);
  assert(result.status === "created");
  const targetScope = { ...scope, sessionId: result.entry.sessionId };
  expect(() => readMessages(targetScope)).toThrow(/projection is rebuilding/);

  await waitForSessionTranscriptProjection(targetScope);
  expect(readMessages(targetScope)).toHaveLength(2);
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

it("forks a Shared parent's history into a source-bound child without visual defaults", async () => {
  const { scope, params } = await createSession();
  await updateEntry(scope, (entry) => ({ ...entry, visibility: "shared" }));
  setRuntimeConfigSnapshot({ session: { sharing: { accessPolicy: { default: "creator" } } } });
  const targetKey = "agent:main:fork:private-history-child";
  const forked = await fork({ ...params, targetKey }, sourceExpectedState);
  expect(forked).toMatchObject({ status: "created" });
  expect(readEntry({ ...scope, sessionKey: targetKey })).toMatchObject({
    access: { mode: "source" },
  });
  expect(readEntry(scope)).toMatchObject({ visibility: "shared" });
});

it.each<{
  name: string;
  access?: InternalSessionEntry["access"];
  visibility: "shared" | "draft";
  privateChild: boolean;
}>([
  { name: "legacy", access: undefined, visibility: "shared", privateChild: false },
  {
    name: "unrestricted",
    access: { mode: "unrestricted" },
    visibility: "shared",
    privateChild: false,
  },
  { name: "creator", access: { mode: "creator" }, visibility: "shared", privateChild: true },
  { name: "source", access: { mode: "source" }, visibility: "shared", privateChild: true },
  {
    name: "audience",
    access: { mode: "audience", profileIds: ["selected"] },
    visibility: "shared",
    privateChild: true,
  },
  {
    name: "draft-unrestricted",
    access: { mode: "unrestricted" },
    visibility: "draft",
    privateChild: true,
  },
])(
  "message fork preserves the $name source confidentiality contract",
  async ({ name, access, visibility, privateChild }) => {
    const { scope, params } = await createSession({ access, visibility });
    const original = readEntry(scope);
    const sourceEvents = await readEvents(scope);
    const targetKey = `agent:main:fork:access-${name}`;
    const forked = await fork({ ...params, targetKey }, sourceExpectedState);
    assert(forked.status === "created");
    const child = readEntry({ ...scope, sessionKey: targetKey });
    assert(child);
    if (privateChild) {
      expect(child.access).toEqual({ mode: "creator" });
    } else {
      expect(child.access).toBeUndefined();
      expect(canReadSessionAccess({}, targetKey, child, () => false)).toBe(true);
    }
    if (visibility === "draft") {
      expect(child.visibility).toBe("draft");
    }
    expect(readEntry(scope)).toEqual(original);
    expect(await readEvents(scope)).toEqual(sourceEvents);
  },
);

it("reads pre-ACL stored history without rewriting its metadata when source policy is toggled", async () => {
  const { scope } = await createSession();
  const before = readEntry(scope);
  assert(before);
  expect(before).not.toHaveProperty("access");
  const events = await readEvents(scope);
  expect(events[0]).toMatchObject({ type: "session", version: 3 });
  for (const enabled of [false, true, false]) {
    const cfg = enabled
      ? { session: { sharing: { accessPolicy: { default: "creator" as const } } } }
      : {};
    setRuntimeConfigSnapshot(cfg);
    const stored = readEntry(scope);
    assert(stored);
    expect(canReadSessionAccess(cfg, scope.sessionKey, stored, () => false)).toBe(true);
    expect(canReadSessionAccess(cfg, scope.sessionKey, stored, () => true)).toBe(true);
    expect(stored).toEqual(before);
    expect(await readEvents(scope)).toEqual(events);
  }
});
