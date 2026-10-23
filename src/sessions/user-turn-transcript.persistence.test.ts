import fs from "node:fs";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { castAgentMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../agents/harness/hook-helpers.js";
import { formatChatWorkContext } from "../chat/work-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSessionTranscriptDatabasePath } from "../config/sessions/session-accessor.transcript-target.js";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import { withSessionTranscriptSourcePublication } from "../config/sessions/transcript-write-context.js";
import { stripEnvelopeFromMessages } from "../gateway/chat-sanitize.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { createUserTurnTranscriptRecorder } from "./user-turn-transcript.js";
import {
  buildChannelUserTurnSender,
  preparePersistedUserTurnMessageForTranscriptWrite,
  restorePreparedUserTurnOperationalMetaForRuntime,
} from "./user-turn-transcript.metadata.js";
import {
  createSqliteTranscriptTarget,
  persistUserTurnTranscript,
  readTranscriptMessages,
} from "./user-turn-transcript.test-support.js";
import type {
  CreateUserTurnTranscriptRecorderParams,
  PersistedUserTurnMessage,
  UserTurnInput,
  UserTurnOriginalInputCommit,
} from "./user-turn-transcript.types.js";

function userMessage(
  content: string,
  overrides: Partial<PersistedUserTurnMessage> = {},
): PersistedUserTurnMessage {
  return { role: "user", content, timestamp: 1, ...overrides };
}

function installWriteHook(write: (message: PersistedUserTurnMessage) => AgentMessage) {
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_message_write",
        handler: (event) => ({
          message: write((event as { message: PersistedUserTurnMessage }).message),
        }),
      },
    ]),
  );
}

const acceptedPeerDelivery = {
  source: { sessionKey: "agent:main:source" },
  operatorSource: {
    kind: "channel",
    snapshot: {
      profileId: "original",
      scopes: ["operator.read"],
    },
  },
};

describe("persistUserTurnTranscript", () => {
  const sessionDirs = useSessionStoreTempDirs(
    (cleanup) =>
      afterAll(async () => {
        await cleanup();
        clearRuntimeConfigSnapshot();
      }),
    "openclaw-user-turn-append-",
  );
  let target: ReturnType<typeof createSqliteTranscriptTarget>;
  const readMessages = () => readTranscriptMessages(target);
  const readMessage = async () => (await readMessages())[0];
  const makeRecorder = (
    params: Omit<CreateUserTurnTranscriptRecorderParams, "target"> &
      Partial<Pick<CreateUserTurnTranscriptRecorderParams, "target">>,
  ) => createUserTurnTranscriptRecorder({ target, ...params });
  const writeInput = (
    input: UserTurnInput,
    options: Partial<Parameters<typeof persistUserTurnTranscript>[0]> = {},
  ) => persistUserTurnTranscript({ ...target, input, ...options });
  const writeAndRead = async (params: Parameters<typeof makeRecorder>[0]) => {
    await makeRecorder(params).persistApproved();
    return readMessage();
  };

  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    target = createSqliteTranscriptTarget({ dir: sessionDirs.make() });
  });

  afterEach(resetGlobalHookRunner);

  it("does not resume a cold transcript when its archive is missing", async () => {
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    await writeInput({ text: "Original history", timestamp: 1 }, { updateMode: "none" });
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: resolveSessionTranscriptDatabasePath(target),
    });
    await replaceSessionEntry(target, {
      ...loadSessionEntry(target),
      updatedAt: 1,
      sessionId: target.sessionId,
      lastActivityAt: 1,
      lastInteractionAt: 1,
    });
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .updateTable("session_windows")
            .set({ updated_at: 1, transcript_updated_at: 1 })
            .where("session_id", "=", target.sessionId),
        );
      },
      { agentId: "main", path: database.path },
    );
    const owner = database.db.prepare("SELECT current_session_id FROM session_nodes").get();
    expect(
      await runSessionColdStorageMaintenance({
        config: {
          agents: { entries: { [target.agentId]: {} } },
          session: {
            store: target.storePath,
            maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
          },
        },
      }),
    ).toMatchObject({ archivedTranscripts: 1, externalizedTranscripts: 0 });
    const descriptor = readSessionColdTranscript(database.db, target.sessionId)!;
    fs.unlinkSync(resolveSessionColdArchivePath(database.path, descriptor.archive_name));
    const recorder = makeRecorder({
      input: { text: "Continue this conversation", timestamp: Date.now() },
      updateMode: "none",
    });
    await expect(recorder.persistApproved()).rejects.toThrow(/missing|unreadable/);
    expect(database.db.prepare("SELECT * FROM transcript_events").all()).toEqual([]);
    expect(readSessionColdTranscript(database.db, target.sessionId)).toEqual(descriptor);
    expect(database.db.prepare("SELECT current_session_id FROM session_nodes").get()).toEqual(
      owner,
    );
  });

  it("does not undo hook redaction when round-tripping captured context", async () => {
    const snapshot = { page: "chat", title: "Parser work", workspace: "/projects/parser" };
    const text = "Explain this task";
    const modelText = text + "\n\n" + formatChatWorkContext(snapshot);
    await writeInput(
      { text: modelText, workContext: { snapshot, text }, timestamp: 123 },
      {
        updateMode: "none",
        beforeMessageWrite: ({ message }) => ({ ...message, content: "[redacted]" }),
      },
    );
    const stored = await readMessage();
    const displayed = stripEnvelopeFromMessages([stored])[0];
    expect(stored).toHaveProperty("content", "[redacted]");
    expect(displayed).toHaveProperty("content", "[redacted]");
    expect(stored).not.toHaveProperty("__openclaw.workContext");
    expect(displayed).not.toHaveProperty("__openclaw.workContext.text");
  });

  it("does not restore original display text after a runtime hook or continuation rewrites it", async () => {
    const input = {
      text: "original prompt",
      workContext: { snapshot: { page: "chat" }, text: "original words" },
      requesterOrigin: { sessionKey: "agent:main:requesters", operatorProfileId: "original" },
    };
    const recorder = makeRecorder({ input, updateMode: "none" });
    const prepared = recorder.message!;
    prepared["__openclaw"] = { ...prepared["__openclaw"], chatRequestIdentity: "original-request" };
    const runtime = restorePreparedUserTurnOperationalMetaForRuntime({
      preparedMessage: prepared,
      runtimeMessage: {
        ...prepared,
        content: "[redacted]",
        __openclaw: {
          ...prepared["__openclaw"],
          chatRequestIdentity: "forged-request",
          requesterOrigin: { sessionKey: "agent:main:forged", operatorProfileId: "forged" },
        },
      },
    });
    expect(stripEnvelopeFromMessages([runtime])[0]).toMatchObject({ content: "[redacted]" });
    expect(runtime).not.toHaveProperty("__openclaw.workContext");
    const operational = {
      chatRequestIdentity: "original-request",
      requesterOrigin: input.requesterOrigin,
    };
    expect(runtime["__openclaw"]).toMatchObject(operational);
    const written = preparePersistedUserTurnMessageForTranscriptWrite(runtime, {
      beforeMessageWrite: ({ message }) => ({ ...message, __openclaw: {} }),
    });
    expect(written).toMatchObject({ content: "[redacted]", __openclaw: operational });
    const unprepared = restorePreparedUserTurnOperationalMetaForRuntime({
      runtimeMessage: runtime,
      preparedMessage: { ...prepared, __openclaw: {} },
    });
    expect(unprepared).not.toHaveProperty("__openclaw.requesterOrigin");
    expect(unprepared).not.toHaveProperty("__openclaw.chatRequestIdentity");
    recorder.replaceTextBeforePersistence?.("approved continuation");
    await recorder.persistApproved();
    const persisted = await readMessage();
    expect(stripEnvelopeFromMessages([persisted])[0]).toMatchObject({
      content: "approved continuation",
    });
    expect(persisted).not.toHaveProperty("__openclaw.workContext");
  });

  it("resolves committed hook metadata and redacted content for runtime replay", async () => {
    const expected = userMessage("[redacted]", {
      timestamp: 123,
      idempotencyKey: "prepared:user",
      __openclaw: { chatRequestIdentity: "admitted-request" },
    });
    const recorder = makeRecorder({
      input: { text: "original input", timestamp: 123, idempotencyKey: "prepared:user" },
      beforeMessageWrite: ({ message }) => ({
        ...message,
        content: expected.content,
        __openclaw: structuredClone(expected["__openclaw"]),
      }),
    });
    await recorder.persistApproved();
    await expect(recorder.resolveMessage()).resolves.toEqual(expected);
  });

  const media = [
    { path: "/tmp/image.png", contentType: "image/png" },
    { url: "https://example.test/report.pdf", contentType: "application/pdf" },
  ];
  const runtimeOnlySenderFields = {
    senderProfileAvatarUrl: "/api/users/8489979671/avatar?v=1989876543210",
    profileRevision: 1_989_876_543_210,
    avatarBytes: "volatile-avatar-bytes",
    avatarHash: "volatile-avatar-hash",
  };
  const profileSender = {
    id: "8489979671",
    name: "Ram Shenoy",
    username: "ram_s",
    identity: { type: "profile" as const, id: "8489979671" },
    ...runtimeOnlySenderFields,
  };
  it.each([
    {
      name: "source bytes and attachments despite logging patterns",
      input: {
        text: "Inspect both\nAPI_TOKEN = computeToken()\nOPENAI_API_KEY=sk-proj-fixture1234567890",
        timestamp: 456,
        media,
      },
      metadata: { media },
      config: { logging: { redactPatterns: ["computeToken"] } },
      forbidden: [],
    },
    {
      name: "durable sender fields without runtime profile data",
      input: { text: "hello from group", timestamp: 1_700_000_000_000, sender: profileSender },
      metadata: {
        senderId: "8489979671",
        senderName: "Ram Shenoy",
        senderUsername: "ram_s",
        senderIdentity: profileSender.identity,
      },
      config: undefined,
      forbidden: Object.entries(runtimeOnlySenderFields).flatMap(([key, value]) => [
        key,
        String(value),
      ]),
    },
  ])("round-trips $name", async ({ input, metadata, config, forbidden }) => {
    const expected = userMessage(input.text, { timestamp: input.timestamp, __openclaw: metadata });
    const appended = await writeInput(structuredClone(input), { config, updateMode: "none" });
    const messages = await readMessages();
    const durable = [appended?.message, messages[0]];
    expect(durable).toEqual([expected, expected]);
    expect(messages).toEqual([expected]);
    const serialized = durable.map((message) => JSON.stringify(message));
    expect(serialized).toEqual([JSON.stringify(expected), JSON.stringify(expected)]);
    for (const bytes of serialized) {
      for (const value of forbidden) {
        expect(bytes).not.toContain(value);
      }
    }
  });

  it("sender provenance round-trips an observation without display inference", async () => {
    const sender = buildChannelUserTurnSender({
      SenderId: "shared-id",
      SenderName: "Same label",
      Provider: "test-channel",
    });
    await writeInput({ text: "hello", sender });
    const message = await readMessage();
    expect(message?.["__openclaw"]).toMatchObject({
      senderId: "shared-id",
      senderName: "Same label",
      senderIdentity: {
        type: "observation",
        id: "shared-id",
        pluginId: "test-channel",
        accountId: null,
        senderKind: "unknown",
      },
    });
  });

  it.each(["retain", "in-place", "raw-redact", "forge"] as const)(
    "sender provenance hook %s respects original producer evidence",
    async (mode) => {
      const identity = { type: "profile", id: "original" };
      const requesterOrigin = {
        sessionKey: "agent:main:telegram:group:requesters",
        messageProvider: "telegram",
        senderId: "original",
      };
      const originalOrigin = structuredClone(requesterOrigin);
      const stored = await writeAndRead({
        input: { requesterOrigin: mode === "forge" ? undefined : requesterOrigin },
        message: userMessage("hello", {
          __openclaw: {
            senderId: "original",
            senderName: "Original",
            senderIsOwner: true,
            ...(mode === "forge"
              ? {}
              : {
                  senderIdentity: identity,
                  sessionSendDelivery: structuredClone(acceptedPeerDelivery),
                }),
          },
        }),
        beforeMessageWrite: ({ message }) => {
          const metadata =
            mode === "in-place" ? message["__openclaw"]! : { ...message["__openclaw"] };
          if (mode === "forge") {
            metadata.senderIdentity = { type: "profile", id: "forged" };
            metadata.sessionSendDelivery = { ...acceptedPeerDelivery, operatorSource: null };
          }
          if (mode === "in-place") {
            (metadata.senderIdentity as { id: string }).id = "forged";
            requesterOrigin.senderId = "forged";
            requesterOrigin.sessionKey = "agent:main:replacement";
            const delivery = metadata.sessionSendDelivery as typeof acceptedPeerDelivery;
            delivery.source.sessionKey = "agent:main:forged";
            delivery.operatorSource.snapshot.profileId = "forged";
            delivery.operatorSource.snapshot.scopes.push("operator.admin");
          }
          if (mode === "raw-redact") {
            delete metadata.senderId;
            delete metadata.sessionSendDelivery;
          }
          return {
            ...message,
            __openclaw: {
              ...metadata,
              senderName: "Edited display",
              senderIsOwner: false,
              requesterOrigin: { sessionKey: "agent:main:forged", senderId: "forged" },
            },
          };
        },
      });
      expect(stored?.["__openclaw"]).toEqual({
        ...(mode === "raw-redact" ? {} : { senderId: "original" }),
        senderName: "Edited display",
        senderIsOwner: true,
        ...(mode === "retain" ? { senderIdentity: { type: "profile", id: "original" } } : {}),
        ...(mode === "forge"
          ? {}
          : { requesterOrigin: originalOrigin, sessionSendDelivery: acceptedPeerDelivery }),
      });
    },
  );

  it.each([undefined, true])(
    "requires explicit runtime append freshness (%s), not an admission anchor",
    async (appended) => {
      const commits: UserTurnOriginalInputCommit[] = [];
      const input = { text: "Hello @Ada", idempotencyKey: "runtime-mention:user" };
      const result = await writeInput(input);
      const recorder = makeRecorder({
        input,
        onOriginalInputCommitted: (commit) => commits.push(commit),
      });
      const persistence = appended === undefined ? undefined : { appended };
      recorder.markRuntimePersisted(result?.message, result?.admission, persistence);
      recorder.markRuntimePersisted(result?.message, result?.admission, persistence);
      expect(recorder.getAdmissionReceipt()?.entryId).toBe(result?.messageId);
      expect(commits).toHaveLength(appended === true ? 1 : 0);
    },
  );

  it.each(["internal", "blocked"] as const)(
    "does not report %s rows as original human input",
    async (kind) => {
      const commits: UserTurnOriginalInputCommit[] = [];
      const message = userMessage(
        "@Ada",
        kind === "internal" ? { provenance: { kind: "internal_system" } } : {},
      );
      const revoked = () => {
        throw new Error("Original input source revoked");
      };
      const recorder = makeRecorder({
        message,
        ...(kind === "blocked"
          ? {
              assertOriginalInputCommit: Object.assign(revoked, {
                prepareSessionSource: async () => revoked(),
              }),
            }
          : {}),
        onOriginalInputCommitted: (commit) => commits.push(commit),
      });
      await (kind === "blocked" ? recorder.persistBlocked(message) : recorder.persistApproved());
      expect(await readMessages()).toHaveLength(1);
      expect(commits).toEqual([]);
    },
  );

  it.each([true, false])(
    "fans committed source mentions back to their own recorders only for an annotated collection (%s)",
    async (annotated) => {
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const commits: UserTurnOriginalInputCommit[] = [];
      const sources = ["ada", "grace"].map((profileId) =>
        makeRecorder({
          input: {
            text: `@${profileId}`,
            idempotencyKey: `${profileId}:user`,
            mentions: [{ profileId, start: 0, end: profileId.length + 1 }],
            sender: {
              id: `sender-${profileId}`,
              identity: { type: "profile", id: `sender-${profileId}` },
            },
          },
          onOriginalInputCommitted: (commit) => commits.push(commit),
        }),
      );
      for (const [index, source] of sources.entries()) {
        await source.stageApproved?.({ runId: `source-${index}`, assertCurrent: () => {} });
      }
      const aggregate = makeRecorder({
        input: {
          text: annotated ? "@ada\n@grace" : "Two queued messages were summarized.",
          idempotencyKey: "aggregate:user",
          ...(annotated
            ? {
                mentions: [
                  { profileId: "ada", start: 0, end: 4 },
                  { profileId: "grace", start: 5, end: 11 },
                ],
              }
            : {}),
        },
        pendingInputSources: sources,
      });
      const result = await aggregate.persistApproved();
      await aggregate.persistFallback();
      expect(result?.appended).toBe(true);
      expect(
        commits.map((commit) => ({
          text: commit.message.content,
          sender: commit.message["__openclaw"]?.senderId,
          entryId: commit.anchor.entryId,
        })),
      ).toEqual(
        annotated
          ? [
              { text: "@ada", sender: "sender-ada", entryId: result?.messageId },
              { text: "@grace", sender: "sender-grace", entryId: result?.messageId },
            ]
          : [],
      );
      expect(await readMessages()).toHaveLength(1);
    },
  );

  it("does not fail or retry a committed input when notification and diagnostic callbacks throw", async () => {
    const notify = vi.fn(() => {
      throw new Error("notification failed");
    });
    const diagnose = vi.fn(() => {
      throw new Error("diagnostic failed");
    });
    const recorder = makeRecorder({
      input: { text: "@Ada", idempotencyKey: "notification-error:user" },
      onOriginalInputCommitted: notify,
      onPersistenceError: diagnose,
    });
    await expect(recorder.persistApproved()).resolves.toMatchObject({ appended: true });
    await recorder.persistFallback();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(diagnose.mock.calls).toEqual([
      [expect.objectContaining({ message: "notification failed" })],
    ]);
    expect(await readMessages()).toHaveLength(1);
  });

  it("retains canonical input custody after committed source publication fails", async () => {
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const failure = new Error("committed source publication failed");
    const sourcePublished = createDeferred();
    const acceptedCompletion = createDeferred();
    const approve = vi.fn(({ message }: { message: PersistedUserTurnMessage }) => ({
      ...message,
      content: "approved input",
    }));
    const createRecorder = () =>
      makeRecorder({
        input: { text: "original input", idempotencyKey: "publication-failure:user" },
        target: { ...target, expectedSessionId: target.sessionId },
        beforeMessageWrite: approve,
        onPersistenceError: () => {},
        updateMode: "none",
      });
    const recorder = createRecorder();
    recorder.setAdmissionHandler?.(() => acceptedCompletion.promise);
    const settled = vi.fn();
    const pending = withSessionTranscriptSourcePublication(
      target,
      () => {
        sourcePublished.resolve();
        throw failure;
      },
      () => recorder.persistApproved(),
    );
    void pending.then(settled, settled);
    const rejected = expect(pending).rejects.toThrow(failure.message);
    try {
      await sourcePublished.promise;
      expect(recorder.hasPersisted()).toBe(true);
      expect(settled).not.toHaveBeenCalled();
    } finally {
      acceptedCompletion.resolve();
    }
    await rejected;

    const stored = await readMessage();
    expect(stored).toMatchObject({ content: "approved input" });
    expect(recorder.hasPersisted()).toBe(true);
    expect(recorder.getPersistedMessage?.()).toEqual(stored);
    const admission = recorder.getAdmissionReceipt();
    expect(admission).toMatchObject({ sessionId: target.sessionId, role: "user" });
    await recorder.persistFallback();

    const reopened = createRecorder();
    await expect(reopened.persistApproved()).resolves.toMatchObject({ appended: false });
    expect(reopened.getPersistedMessage?.()).toEqual(stored);
    expect(reopened.getAdmissionReceipt()?.entryId).toBe(admission?.entryId);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(await readMessages()).toEqual([stored]);
  });

  it.each(["replace-text", "mutate-spans", "forge"] as const)(
    "keeps human selections bound to their original bytes through hook %s",
    async (mode) => {
      const mentions = [{ profileId: "ada", start: 6, end: 10 }];
      const stored = await writeAndRead({
        input: { text: "Hello @Ada", ...(mode === "forge" ? {} : { mentions }) },
        beforeMessageWrite: ({ message }) => {
          if (mode === "mutate-spans") {
            message["__openclaw"]!.humanMentions![0]!.profileId = "forged";
          }
          return {
            ...message,
            content: mode === "replace-text" ? "[redacted]" : message.content,
            __openclaw: { humanMentions: [{ profileId: "forged", start: 0, end: 6 }] },
          };
        },
      });
      const metadata = stored?.["__openclaw"] as { humanMentions?: unknown } | undefined;
      expect({ content: stored?.content, mentions: metadata?.humanMentions }).toEqual({
        content: mode === "replace-text" ? "[redacted]" : "Hello @Ada",
        mentions: mode === "replace-text" || mode === "forge" ? undefined : mentions,
      });
    },
  );

  it("returns the existing user turn when the idempotency key was already persisted", async () => {
    const first = await writeInput(
      { text: "hello once", timestamp: 123, idempotencyKey: "chat-run-1:user" },
      { updateMode: "none" },
    );
    const second = await writeInput(
      { text: "hello once replayed", timestamp: 456, idempotencyKey: "chat-run-1:user" },
      { updateMode: "none" },
    );
    const expected = {
      role: "user",
      content: "hello once",
      timestamp: 123,
      idempotencyKey: "chat-run-1:user",
    };
    expect(second?.messageId).toBe(first?.messageId);
    expect(second?.message).toMatchObject(expected);
    await expect(readMessages()).resolves.toEqual([expect.objectContaining(expected)]);
  });

  it("preserves transcript metadata when before_message_write replaces a user turn", async () => {
    let hookCalls = 0;
    const provenance = {
      kind: "inter_session" as const,
      sourceSessionKey: "source-main",
      sourceTool: "sessions_send",
    };
    const metadata = {
      replyToId: "transcript-reply-1",
      replyToPreview: { text: "Original reply", senderLabel: "Molty" },
      transport: {
        channel: "reef",
        conversationRef: "conv_0123456789abcdef0123456789abcdef",
        messageId: "inbound-1",
        replyToId: "outbound-1",
        clients: [{ id: "cli", mode: "cli", displayName: "Original app" }],
      },
    } satisfies Pick<UserTurnInput, "replyToId" | "replyToPreview" | "transport">;
    installWriteHook((message) => {
      hookCalls += 1;
      const transport = message["__openclaw"]!.transport as typeof metadata.transport;
      transport.conversationRef = "conv_tampered";
      transport.messageId = "tampered-message";
      transport.clients![0]!.displayName = "Forged app";
      return castAgentMessage({
        role: "user",
        content: "[redacted by hook]",
        __openclaw: { hookOwned: true },
      });
    });
    const persist = () =>
      writeInput(
        {
          text: "secret prompt",
          idempotencyKey: "chat-run-1:user",
          ...structuredClone(metadata),
          senderIsOwner: true,
          provenance,
          sender: { id: "user-42", name: "Ada" },
        },
        {
          beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
        },
      );
    await persist();
    await persist();

    await expect(readMessages()).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "[redacted by hook]",
        idempotencyKey: "chat-run-1:user",
        provenance,
        __openclaw: {
          hookOwned: true,
          ...metadata,
          senderIsOwner: false,
        },
      }),
    ]);
    expect(hookCalls).toBe(1);
  });

  it.each([true, false])(
    "protects internal Goal metadata across write hooks (Goal: %s)",
    async (isGoal) => {
      const intent = {
        kind: "session-goal-resume",
        version: 1,
        goalId: "goal-1",
        operationId: "resume-1",
      };
      const message = await writeAndRead({
        message: userMessage("Continue pursuing the current goal.", {
          timestamp: 123,
          ...(isGoal
            ? {
                display: false as const,
                provenance: { kind: "internal_system" as const },
                __openclaw: { intent },
              }
            : {}),
        }),
        beforeMessageWrite: () =>
          castAgentMessage({
            role: "user",
            content: "redacted",
            timestamp: 123,
            display: true,
            provenance: { kind: "external_user" },
            __openclaw: { intent: { kind: "forged" } },
          }),
      });
      expect((message?.["__openclaw"] as Record<string, unknown> | undefined)?.intent).toEqual(
        isGoal ? intent : undefined,
      );
      if (isGoal) {
        expect(message).toMatchObject({ display: false, provenance: { kind: "internal_system" } });
      }
    },
  );

  it.each(["active-run", undefined])(
    "rejects hook-forged steer targets with producer target %s",
    async (producerTarget) => {
      installWriteHook((message) => ({
        ...message,
        __openclaw: { ...message["__openclaw"], steerTargetRunId: "forged-run" },
      }));
      const recorder = makeRecorder({
        input: {
          text: "steer or queue",
          idempotencyKey: "chat-run-steer-target:user",
        },
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      });
      if (producerTarget) {
        await recorder.confirmSteerTargetRunIdForPersistence?.(producerTarget);
      }
      await recorder.persistApproved();

      const message = await readMessage();
      const metadata = message?.["__openclaw"] as Record<string, unknown> | undefined;
      expect(metadata?.steerTargetRunId).toBe(producerTarget);
    },
  );
});
