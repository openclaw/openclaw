import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  forkSessionAtMessage,
  listSessionBranches,
  listSessionParticipantsReadOnly,
  loadSessionEntry,
  loadTranscriptEvents,
  readSessionTranscriptMessageEventPage,
  readSessionTranscriptMessageEvents,
  rewindSessionToMessage,
  switchSessionBranch,
  updateSessionEntry,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SQLite session message cuts", () => {
  it("returns missing-session for history navigation in an absent store", async () => {
    const { env } = await createSession();
    const missing = { env, agentId: "absent", sessionKey: "agent:absent:missing" };
    await expect(rewindSessionToMessage({ ...missing, entryId: "user-2" })).resolves.toEqual({
      status: "missing-session",
    });
    await expect(switchSessionBranch({ ...missing, leafEntryId: "assistant-2" })).resolves.toEqual({
      status: "missing-session",
    });
    const denied = new Error("Missing-store navigation authority was revoked");
    await expect(
      rewindSessionToMessage({
        ...missing,
        entryId: "user-2",
        commitGuard() {
          throw denied;
        },
      }),
    ).rejects.toBe(denied);
  });

  it("returns a committed rewind after identity publication retires its old authority", async () => {
    const { env, scope } = await createSession();
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
      const result = await rewindSessionToMessage(
        {
          agentId,
          env,
          sessionKey,
          entryId: "user-2",
          commitGuard() {
            if (!current) {
              throw new Error("The old session authority ended after publication");
            }
          },
        },
        sourceExpectedState,
      );
      expect(result.status).toBe("created");
      expect(current).toBe(false);
      expect(loadSessionEntry(scope)?.previousSessionId).toBe(scope.sessionId);
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
      const reader = new DatabaseSync(pathname, { readOnly: true });
      try {
        return {
          entries: reader
            .prepare(
              "SELECT session_key, current_session_id, entry_json FROM session_nodes ORDER BY session_key",
            )
            .all(),
          transcripts: reader
            .prepare("SELECT * FROM transcript_events ORDER BY session_id, seq")
            .all(),
        };
      } finally {
        reader.close();
      }
    };
    const before = readStoredState(database.path);
    expect(before.entries).toEqual([
      expect.objectContaining({ session_key: sessionKey, current_session_id: scope.sessionId }),
    ]);
    expect(before.transcripts.length).toBeGreaterThan(0);
    expect(readStoredState(replacementPath)).toEqual(before);

    let originalMoved = false;
    let replacementMoved = false;
    const mutation = rewindSessionToMessage({
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

  it("returns authored text without captured context or attachments on fork", async () => {
    const { env, scope } = await createSession();
    const text = "Edit only these words";
    const snapshot = { page: "chat", title: "Captured work" };
    await appendTranscriptMessage(scope, {
      eventId: "context-input",
      parentId: "assistant-2",
      message: {
        role: "user",
        content: text + "\n\nWorking context captured at send time. " + JSON.stringify(snapshot),
        __openclaw: { workContext: { snapshot, text } },
      },
      now: Date.now(),
    });
    const params = { agentId, env, sessionKey, entryId: "context-input" };
    const result = await forkSessionAtMessage({
      ...params,
      targetKey: sessionKey + ":context-fork",
    });
    expect(result).toMatchObject({ status: "created", editorText: text });
    expect(result).not.toHaveProperty("editorAttachments");
    expect(result).not.toHaveProperty("editorMediaRefs");
  });

  it("drains fixture resources before retiring native handles and removing the root", async ({
    onTestFinished,
  }) => {
    const { env } = await createSession();
    const agentDatabase = openOpenClawAgentDatabase({ agentId, env });
    const stateDatabase = openOpenClawStateDatabase({ env });
    const closingSnapshots: Array<{ agentOpen: boolean; stateOpen: boolean; rootExists: boolean }> =
      [];
    registerOpenClawAgentDatabaseAsyncResource({
      agentId,
      path: agentDatabase.path,
      revoke: () => {},
      close: async () => {
        await Promise.resolve();
        closingSnapshots.push({
          agentOpen: agentDatabase.db.isOpen,
          stateOpen: stateDatabase.db.isOpen,
          rootExists: fs.existsSync(env.OPENCLAW_STATE_DIR),
        });
      },
    });

    // Inspect real fixture teardown after both consumer and helper afterEach hooks run.
    onTestFinished(() => {
      expect(closingSnapshots).toEqual([{ agentOpen: true, stateOpen: true, rootExists: true }]);
      expect(agentDatabase.db.isOpen).toBe(false);
      expect(stateDatabase.db.isOpen).toBe(false);
      expect(fs.existsSync(env.OPENCLAW_STATE_DIR)).toBe(false);
    });
  });

  it.each(["rewind", "fork"] as const)(
    "rejects %s when the source lifecycle changes in the writer queue",
    async (mode) => {
      const { env, scope } = await createSession();
      const ownerChangeGate = createDeferred();
      const ownerChangeStarted = createDeferred();
      const ownerChange = updateSessionEntry(scope, async () => {
        ownerChangeStarted.resolve();
        await ownerChangeGate.promise;
        return { lifecycleRevision: "replacement-lifecycle-revision" };
      });
      await ownerChangeStarted.promise;

      const targetKey = `${sessionKey}:raced-fork`;
      const mutation =
        mode === "rewind"
          ? rewindSessionToMessage({
              agentId,
              env,
              entryId: "user-2",
              sessionKey,
            })
          : forkSessionAtMessage({
              agentId,
              env,
              entryId: "user-2",
              sessionKey,
              targetKey,
            });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      ownerChangeGate.resolve();

      await ownerChange;
      await expect(mutation).resolves.toEqual({ status: "conflict" });
      expect(loadSessionEntry(scope)).toMatchObject({
        lifecycleRevision: "replacement-lifecycle-revision",
        sessionId: sourceExpectedState.sessionId,
      });
      expect(loadSessionEntry({ agentId, env, sessionKey: targetKey })).toBeUndefined();
      await expect(listSessionBranches({ agentId, env, sessionKey })).resolves.toMatchObject({
        status: "ok",
        branches: expect.arrayContaining([
          expect.objectContaining({ active: true, leafEntryId: "assistant-2" }),
        ]),
      });
    },
  );

  it("switches to another tip and rebuilds the active-path projection", async () => {
    const { env } = await createSession();

    const result = await switchSessionBranch({
      agentId,
      env,
      leafEntryId: "off-path-user",
      sessionKey,
    });

    expect(result).toMatchObject({ status: "created", key: sessionKey });
    if (result.status !== "created") {
      throw new Error("expected branch switch result");
    }
    const activeEventIds = readSessionTranscriptMessageEvents({
      agentId,
      env,
      sessionId: result.entry.sessionId,
      sessionKey,
    }).map(({ event }) =>
      event && typeof event === "object" && "id" in event ? event.id : undefined,
    );
    expect(activeEventIds).toEqual(["user-1", "off-path-user"]);
    expect(result.entry).toMatchObject({
      agentHarnessId: undefined,
      claudeCliSessionId: undefined,
      cliSessionBindings: undefined,
      cliSessionIds: undefined,
    });
  });

  it("rewinds by repointing the active leaf and returns the editor text", async () => {
    const { env, scope } = await createSession();
    const legacyCheckpoints = [
      {
        sessionId: scope.sessionId,
        preCompaction: { sessionId: scope.sessionId },
        postCompaction: { sessionId: scope.sessionId },
      },
    ];
    await updateSessionEntry(scope, (entry) => ({
      ...entry,
      compactionCheckpoints: legacyCheckpoints,
    }));

    const canonicalKey = "agent:main:canonical-message-cut";
    const result = await rewindSessionToMessage({
      agentId,
      env,
      entryId: "user-2",
      sessionKey: canonicalKey,
      sessionStoreKey: sessionKey,
    });

    expect(result).toMatchObject({
      status: "created",
      key: sessionKey,
      editorText: "second prompt",
      editorAttachments: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
      editorMediaRefs: [
        { path: "/state/media/inbound/stored-image.png", contentType: "image/png" },
      ],
    });
    if (result.status !== "created") {
      throw new Error("expected rewind result");
    }
    expect(
      readSessionTranscriptMessageEventPage(
        { agentId, env, sessionId: result.entry.sessionId },
        { maxMessages: 0, offset: 0 },
      ).totalMessages,
    ).toBe(2);
    expect(loadSessionEntry({ agentId, env, sessionKey })?.sessionId).toBe(result.entry.sessionId);
    expect(loadSessionEntry({ agentId, env, sessionKey: canonicalKey })).toBeUndefined();
    expect(loadSessionEntry(scope)).toHaveProperty("compactionCheckpoints", legacyCheckpoints);
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
    const { env, scope } = await createSession();
    await appendTranscriptEvent(scope, {
      type: "oversized-padding",
      padding: "x".repeat(SYNC_REBUILD_MAX_BYTES),
    });

    const result = await rewindSessionToMessage({
      agentId,
      env,
      entryId: "user-2",
      sessionKey,
    });
    if (result.status !== "created") {
      throw new Error("expected oversized rewind result");
    }
    const targetScope = { agentId, env, sessionId: result.entry.sessionId, sessionKey };
    expect(() => readSessionTranscriptMessageEvents(targetScope)).toThrow(
      /projection is rebuilding/,
    );

    await waitForSessionTranscriptProjection(targetScope);
    expect(readSessionTranscriptMessageEvents(targetScope)).toHaveLength(2);
  });

  it("forks an exact active-path prefix without changing the source", async () => {
    const { env, scope } = await createSession();
    const legacyCheckpoints = [
      {
        sessionId: scope.sessionId,
        preCompaction: { sessionId: scope.sessionId },
        postCompaction: { sessionId: scope.sessionId },
      },
    ];
    await updateSessionEntry(scope, (entry) => ({
      ...entry,
      compactionCheckpoints: legacyCheckpoints,
    }));
    const canonicalSourceKey = "agent:main:canonical-message-cut-source";
    const targetKey = "agent:main:dashboard:message-cut-fork";
    recordSessionParticipant(scope, {
      identity: { type: "profile", id: "source-person" },
      promptedAt: 7,
    });

    const sql = observeHostDataSql();
    let result;
    try {
      result = await forkSessionAtMessage({
        agentId,
        env,
        entryId: "user-2",
        sessionKey: canonicalSourceKey,
        sessionStoreKey: sessionKey,
        targetKey,
      });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }

    expect(result).toMatchObject({
      status: "created",
      key: targetKey,
      editorText: "second prompt",
      editorAttachments: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
      editorMediaRefs: [
        { path: "/state/media/inbound/stored-image.png", contentType: "image/png" },
      ],
    });
    if (result.status !== "created") {
      throw new Error("expected fork result");
    }
    const forkEvents = await loadTranscriptEvents({
      agentId,
      env,
      sessionId: result.entry.sessionId,
      sessionKey: targetKey,
    });
    expect(forkEvents[0]).toMatchObject({ type: "session", version: 3 });
    expect(
      forkEvents.flatMap((event) =>
        event && typeof event === "object" && "id" in event ? [event.id] : [],
      ),
    ).toEqual([result.entry.sessionId, "user-1", "assistant-1"]);
    expect(loadSessionEntry(scope)?.sessionId).toBe(scope.sessionId);
    expect(loadSessionEntry(scope)).toHaveProperty("compactionCheckpoints", legacyCheckpoints);
    expect(loadSessionEntry({ agentId, env, sessionKey: targetKey })).not.toHaveProperty(
      "compactionCheckpoints",
    );
    expect(listSessionParticipantsReadOnly({ agentId, env }).get(targetKey)).toBeUndefined();
    expect(listSessionParticipantsReadOnly({ agentId, env }).get(sessionKey)).toEqual([
      {
        identity: { type: "profile", id: "source-person" },
        contributionCount: 1,
        firstPromptedAt: 7,
        lastPromptedAt: 7,
      },
    ]);
    expect(result.entry.lifecycleRevision).not.toBe("source-lifecycle-revision");
    expect((result.entry as InternalSessionEntry).lifecycleRunId).toBeUndefined();
    expect((result.entry as InternalSessionEntry).lastRunId).toBeUndefined();
    expect(result.entry.cliSessionBindings).toBeUndefined();
    expect(deliveryContextFromSession(result.entry)).toBeUndefined();
    expect(result.entry.parentSessionKey).toBe(canonicalSourceKey);
    expect(result.entry.previousSessionId).toBeUndefined();
    expect(result.entry.forkedFromParent).toBeUndefined();
    expect(result.entry.createdVia).toBeUndefined();
    expect(result.entry.createdActor).toBeUndefined();
    expect(result.entry.createdAt).toBeUndefined();
    expect(result.entry.forkSource).toEqual({
      sessionKey: canonicalSourceKey,
      sessionId: "message-cut-source",
      entryId: "user-2",
    });
    expect(result.entry).toMatchObject({
      modelOverride: "gpt-5",
      modelOverrideSource: "user",
      providerOverride: "openai",
    });
    expect(loadSessionEntry(scope)?.lifecycleRevision).toBe("source-lifecycle-revision");
  });
});
