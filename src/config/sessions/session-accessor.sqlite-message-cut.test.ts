import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
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
  it.each(["rewind", "fork"] as const)(
    "returns authored text, not attached context, on %s",
    async (mode) => {
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
      const result =
        mode === "rewind"
          ? await rewindSessionToMessage(params)
          : await forkSessionAtMessage({ ...params, targetKey: sessionKey + ":context-fork" });
      expect(result).toMatchObject({ status: "created", editorText: text });
    },
  );

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

  it.each(["rewind", "switch", "fork"] as const)(
    "rejects %s when the source lifecycle changes in the writer queue",
    async (mode) => {
      const { env, scope } = await createSession();
      let releaseOwnerChange = () => {};
      const ownerChangeGate = new Promise<void>((resolve) => {
        releaseOwnerChange = resolve;
      });
      let markOwnerChangeStarted = () => {};
      const ownerChangeStarted = new Promise<void>((resolve) => {
        markOwnerChangeStarted = resolve;
      });
      const ownerChange = updateSessionEntry(scope, async () => {
        markOwnerChangeStarted();
        await ownerChangeGate;
        return { lifecycleRevision: "replacement-lifecycle-revision" };
      });
      await ownerChangeStarted;

      const targetKey = `${sessionKey}:raced-fork`;
      const mutation =
        mode === "rewind"
          ? rewindSessionToMessage({
              agentId,
              env,
              entryId: "user-2",
              sessionKey,
            })
          : mode === "switch"
            ? switchSessionBranch({
                agentId,
                env,
                leafEntryId: "off-path-user",
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
      releaseOwnerChange();

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

  it.each([
    ["unknown", "missing-entry"],
    ["user-1", "not-branch-tip"],
    ["assistant-2", "already-active"],
  ])("rejects branch switch target %s with %s", async (leafEntryId, status) => {
    const { env } = await createSession();

    await expect(
      switchSessionBranch({
        agentId,
        env,
        leafEntryId,
        sessionKey,
      }),
    ).resolves.toMatchObject({ status });
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

    const result = await rewindSessionToMessage({
      agentId,
      env,
      entryId: "user-2",
      sessionKey,
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

  it("omits editor attachments for a text-only message", async () => {
    const { env } = await createSession();

    const result = await rewindSessionToMessage({
      agentId,
      env,
      entryId: "user-1",
      sessionKey,
    });

    expect(result).toMatchObject({ status: "created", editorText: "first prompt" });
    expect(result).not.toHaveProperty("editorAttachments");
    expect(result).not.toHaveProperty("editorMediaRefs");
  });

  it("rewinds the stored row when its canonical key differs", async () => {
    const { env } = await createSession();
    const canonicalKey = "agent:main:canonical-message-cut";

    const result = await rewindSessionToMessage({
      agentId,
      env,
      entryId: "user-2",
      sessionKey: canonicalKey,
      sessionStoreKey: sessionKey,
    });

    expect(result).toMatchObject({ status: "created", key: sessionKey });
    if (result.status !== "created") {
      throw new Error("expected rewind result");
    }
    expect(loadSessionEntry({ agentId, env, sessionKey })?.sessionId).toBe(result.entry.sessionId);
    expect(loadSessionEntry({ agentId, env, sessionKey: canonicalKey })).toBeUndefined();
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

    const result = await forkSessionAtMessage({
      agentId,
      env,
      entryId: "user-2",
      sessionKey: canonicalSourceKey,
      sessionStoreKey: sessionKey,
      targetKey,
    });

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

  it.each([
    ["unknown", "missing-entry"],
    ["assistant-1", "not-user-message"],
    ["off-path-user", "off-active-path"],
  ])("rejects %s with %s", async (entryId, status) => {
    const { env } = await createSession();

    await expect(
      rewindSessionToMessage({
        agentId,
        env,
        entryId,
        sessionKey,
      }),
    ).resolves.toMatchObject({ status });
  });
});
