import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { registerTranscriptMarkerQueueTests } from "./server-session-events.marker-queue.test-support.js";
import {
  createGatewayBroadcaster,
  createHandler,
  createTranscriptUpdateBroadcastHandler,
  emitAssistantTranscriptUpdate,
  expectPrivateSessionInvalidation,
  fixedStoreRuntimeConfig,
  listAccessorSessionEntriesReadOnlyMock,
  loadAccessorSessionEntryReadOnlyMock,
  loadGatewaySessionEntryReadOnlyMock,
  loadGatewaySessionRowMock,
  ownerGoal,
  projectChatDisplayMessageMock,
  readSessionMessageByIdAsyncMock,
  readSessionMessageCountAsyncMock,
  resolveEmbeddedAgentSessionProgressStateMock,
  runtimeConfigState,
  sessionRow,
  storedMessage,
  subscribePluginSessionsChanged,
} from "./server-session-events.test-support.js";
import { GatewayClientRegistry } from "./server/client-registry.js";

function transcriptTarget(storePath: string) {
  return { agentId: "main", sessionId: "sess-main", sessionKey: "agent:main:main", storePath };
}

function textMessage(role: string, text: string) {
  return { role, content: [{ type: "text", text }] };
}

function expectBroadcast(
  broadcast: ReturnType<typeof vi.fn>,
  event: string,
  payload: Record<string, unknown>,
  recipients: unknown = expect.any(Set),
) {
  expect(broadcast).toHaveBeenCalledWith(
    event,
    expect.objectContaining(payload),
    recipients,
    expect.objectContaining({ prepareSessionProjection: expect.any(Function) }),
  );
}

function expectAbsent(payload: unknown, ...fields: string[]) {
  for (const field of fields) {
    expect(payload, field).not.toHaveProperty(field);
  }
}

const defaultEntry = { sessionId: "sess-main", updatedAt: 1 };
const runningSnapshot = {
  sessionKey: "agent:main:main",
  status: "running",
  hasActiveRun: true,
  session: expect.objectContaining({
    key: "agent:main:main",
    status: "running",
    hasActiveRun: true,
  }),
};
function entryWithRevision(lifecycleRevision: string) {
  return { ...defaultEntry, lifecycleRevision };
}

type TranscriptUpdate = Parameters<ReturnType<typeof createHandler>["handler"]>[0];
function fileUpdate(message: unknown, overrides: Partial<TranscriptUpdate> = {}): TranscriptUpdate {
  return {
    sessionFile: "/tmp/sess-main.jsonl",
    sessionKey: "agent:main:main",
    messageId: "message-1",
    messageSeq: 1,
    message,
    ...overrides,
  };
}
async function publishMessage(
  update: TranscriptUpdate,
  expected: Record<string, unknown> = {},
  active = false,
) {
  const { messageId, messageSeq } = update;
  const { broadcastToConnIds: broadcast, handler } = createHandler(active);
  await handler(update);
  expect(broadcast).toHaveBeenCalledOnce();
  expectBroadcast(broadcast, "session.message", {
    sessionKey: "agent:main:main",
    messageId,
    ...(messageSeq === undefined ? {} : { messageSeq }),
    ...expected,
  });
  return broadcast;
}

describe("createTranscriptUpdateBroadcastHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEmbeddedAgentSessionProgressStateMock.mockReturnValue(undefined);
    listAccessorSessionEntriesReadOnlyMock.mockReturnValue([]);
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue(undefined);
    loadGatewaySessionEntryReadOnlyMock.mockReturnValue({ entry: undefined, storePath: "" });
    loadGatewaySessionRowMock.mockReturnValue(sessionRow);
    readSessionMessageCountAsyncMock.mockReset().mockResolvedValue(undefined);
    readSessionMessageByIdAsyncMock
      .mockReset()
      .mockImplementation(async (_scope, id: string) => storedMessage(id));
    runtimeConfigState.value = {};
    sessionRow.key = "agent:main:main";
    sessionRow.thinkingLevel = "ultra";
  });

  it("reads canonical content and placement from one selected snapshot", async () => {
    const transcriptPosition = { source: "replacement-generation", rawSeq: 10 };
    readSessionMessageByIdAsyncMock.mockResolvedValueOnce({
      found: true,
      oversized: false,
      seq: 7,
      message: {
        role: "assistant",
        content: "replacement",
        __openclaw: { id: "same-id", transcriptPosition },
      },
    });
    await publishMessage(
      {
        target: transcriptTarget("/tmp/canonical-update.sqlite"),
        messageId: "same-id",
        messageSeq: 1,
        message: { role: "assistant", content: "stale queued content" },
      },
      {
        messageSeq: 7,
        message: expect.objectContaining({
          content: "replacement",
          __openclaw: expect.objectContaining({ transcriptPosition }),
        }),
      },
    );
  });

  it("never silently drops an authoritative session message for a slow subscriber", async () => {
    await publishMessage(
      fileUpdate(textMessage("user", "shared durable prompt"), {
        messageId: "durable-user-1",
      }),
    );
  });

  it("invalidates broad and targeted subscribers once for an identity-only commit", async () => {
    const broadConnIds = new Set(["conn-broad", "conn-shared"]);
    const targetConnIds = new Set(["conn-targeted", "conn-shared"]);
    const getSessionMessageSubscribers = vi.fn((sessionKey: string) =>
      sessionKey === "agent:main:main" ? targetConnIds : new Set<string>(),
    );
    const broadcastToConnIds = vi.fn();
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue(entryWithRevision("committed-revision"));
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => broadConnIds },
      sessionMessageSubscribers: { get: getSessionMessageSubscribers },
      chatAbortControllers: new Map(),
    });

    await handler({
      target: transcriptTarget("/tmp/identity-only-custom-sessions.json"),
      lifecycleRevision: "committed-revision",
    });

    expect(broadcastToConnIds).toHaveBeenCalledOnce();
    expect(getSessionMessageSubscribers).toHaveBeenCalledWith("agent:main:main");
    expect(loadAccessorSessionEntryReadOnlyMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: "/tmp/identity-only-custom-sessions.json",
    });
    expectBroadcast(
      broadcastToConnIds,
      "sessions.changed",
      {
        sessionKey: "agent:main:main",
        agentId: "main",
        sessionId: "sess-main",
        phase: "message",
      },
      new Set(["conn-broad", "conn-shared", "conn-targeted"]),
    );
    const payload = broadcastToConnIds.mock.calls[0]?.[1];
    expectAbsent(
      payload,
      "message",
      "messageId",
      "messageSeq",
      "lifecycleRevision",
      "storePath",
      "target.storePath",
    );
    expect(readSessionMessageCountAsyncMock).not.toHaveBeenCalled();
  });

  it("scopes a queued marker update to its final transcript key", async () => {
    listAccessorSessionEntriesReadOnlyMock
      .mockReturnValueOnce([{ key: "agent:main:queued", entry: { sessionId: "sess-main" } }])
      .mockReturnValue([{ key: "agent:main:current", entry: { sessionId: "sess-main" } }]);
    const getSessionMessageSubscribers = vi.fn((sessionKey: string) =>
      sessionKey === "agent:main:current" ? new Set(["conn-current"]) : new Set(["conn-stale"]),
    );
    const { broadcastToConnIds, handler } = createHandler(
      false,
      true,
      getSessionMessageSubscribers,
    );

    await handler({
      sessionFile: "sqlite:main:sess-main:/tmp/explicit-sessions.json",
    });

    expect(getSessionMessageSubscribers).toHaveBeenCalledWith("agent:main:current");
    expect(getSessionMessageSubscribers).not.toHaveBeenCalledWith("agent:main:queued");
    expectBroadcast(
      broadcastToConnIds,
      "sessions.changed",
      { sessionKey: "agent:main:current" },
      new Set(["conn-1", "conn-current"]),
    );
  });

  it("rejects an identity-only invalidation when its custom-store owner was deleted", async () => {
    const { broadcastToConnIds, handler } = createHandler(false);
    await handler({
      target: transcriptTarget("/tmp/deleted-identity-only-sessions.json"),
      lifecycleRevision: "deleted-revision",
    });

    expect(loadAccessorSessionEntryReadOnlyMock).toHaveBeenCalledOnce();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
    expect(readSessionMessageCountAsyncMock).not.toHaveBeenCalled();
  });

  registerTranscriptMarkerQueueTests();

  it.each([
    ["committed", "revised", "revision-before-reset"],
    ["legacy", "revised", undefined],
    ["committed", "deleted", "revision-before-reset"],
    ["committed", "rebound", "revision-before-reset"],
  ])(
    "discards a queued %s message when its session owner is %s",
    async (_updateSource, ownerChange, lifecycleRevision) => {
      let currentEntry: ReturnType<typeof entryWithRevision> | undefined =
        entryWithRevision("revision-before-reset");
      loadAccessorSessionEntryReadOnlyMock.mockImplementation(() => currentEntry);
      loadGatewaySessionEntryReadOnlyMock.mockReturnValue({
        entry: entryWithRevision("revision-before-reset"),
        storePath: "/tmp/default-lifecycle-sessions.json",
      });
      const messageRead = createDeferredCore<ReturnType<typeof storedMessage>>();
      readSessionMessageByIdAsyncMock.mockImplementation(() => messageRead.promise);
      const { broadcastToConnIds, handler } = createHandler(false);

      const pendingBroadcast = handler({
        target: transcriptTarget("/tmp/reset-lifecycle-sessions.json"),
        ...(lifecycleRevision ? { lifecycleRevision } : {}),
        message: textMessage("user", "deleted by reset"),
        messageId: "message-before-reset",
      });

      await vi.waitFor(() => expect(readSessionMessageByIdAsyncMock).toHaveBeenCalledOnce());
      if (ownerChange === "deleted") {
        currentEntry = undefined;
      } else if (ownerChange === "rebound") {
        currentEntry.sessionId = "sess-replacement";
      } else {
        currentEntry.lifecycleRevision = "revision-after-reset";
      }
      messageRead.resolve(storedMessage("message-before-reset"));

      await pendingBroadcast;
      expect(loadGatewaySessionEntryReadOnlyMock).not.toHaveBeenCalled();
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    },
  );

  it("validates a committed custom-store owner without exposing private identity", async () => {
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue(entryWithRevision("current-revision"));
    loadGatewaySessionEntryReadOnlyMock.mockReturnValue({
      entry: entryWithRevision("unrelated-default-revision"),
      storePath: "/tmp/default-lifecycle-sessions.json",
    });
    const broadcast = await publishMessage({
      target: transcriptTarget("/tmp/current-lifecycle-sessions.json"),
      lifecycleRevision: "current-revision",
      message: textMessage("user", "current prompt"),
      messageId: "message-current-lifecycle",
      messageSeq: 1,
    });

    expect(loadAccessorSessionEntryReadOnlyMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: "/tmp/current-lifecycle-sessions.json",
    });
    expect(loadGatewaySessionEntryReadOnlyMock).not.toHaveBeenCalled();
    const payload = broadcast.mock.calls[0]?.[1];
    expectAbsent(payload, "lifecycleRevision", "storePath", "target.storePath");
  });

  it("keeps committed messages visible when the current owner has no legacy revision", async () => {
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue({ ...defaultEntry });
    await publishMessage({
      target: transcriptTarget("/tmp/revisionless-owner-sessions.json"),
      lifecycleRevision: "committed-revision",
      message: textMessage("user", "revisionless owner"),
      messageId: "revisionless-owner-message",
      messageSeq: 1,
    });
  });

  it("preserves revisionless transcript updates when ownership is unavailable", async () => {
    readSessionMessageByIdAsyncMock.mockResolvedValueOnce(
      storedMessage("legacy-lifecycle-message", 3),
    );
    await publishMessage(
      {
        target: transcriptTarget("/tmp/legacy-lifecycle-sessions.json"),
        message: textMessage("user", "legacy prompt"),
        messageId: "legacy-lifecycle-message",
      },
      { messageSeq: 3 },
    );
  });

  it("carries terminal assistant run ownership while plugin finalization keeps the run active", async () => {
    // before_agent_finalize hooks run after the assistant transcript write but
    // before terminal delivery. The active-run registry remains authoritative
    // during that interval even when the persisted session row says done.
    await publishMessage(
      fileUpdate(textMessage("assistant", "Final answer"), {
        runId: "run-before-finalize",
      }),
      {
        ...runningSnapshot,
        runId: "run-before-finalize",
      },
      true,
    );
  });

  it("projects running status into ordinary startup transcript snapshots", async () => {
    await expect(emitAssistantTranscriptUpdate(true, undefined, false)).resolves.toMatchObject(
      runningSnapshot,
    );
  });

  it("keeps stable thinking state without catalog-derived picker metadata", async () => {
    const payload = await emitAssistantTranscriptUpdate(false);

    expect(payload).toMatchObject({
      session: {
        thinkingLevel: "ultra",
        agentRuntime: { id: "openclaw" },
      },
    });
    for (const field of ["thinkingLevels", "thinkingOptions", "thinkingDefault"]) {
      expectAbsent(payload, field, `session.${field}`);
    }
  });

  it("emits explicit tombstones in transcript snapshots", async () => {
    sessionRow.thinkingLevel = undefined;

    await expect(emitAssistantTranscriptUpdate(false)).resolves.toMatchObject({
      agentStatus: null,
      observerDigest: null,
      session: { thinkingLevel: null, agentStatus: null, observerDigest: null },
    });
  });

  it("keeps stale-run recovery when terminal lifecycle has cleared active projection", async () => {
    await expect(emitAssistantTranscriptUpdate(false)).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      hasActiveRun: false,
      session: { hasActiveRun: false },
    });
  });

  it("keeps transcript snapshots active for embedded or channel reply runs", async () => {
    resolveEmbeddedAgentSessionProgressStateMock.mockImplementation((sessionId) =>
      sessionId === "sess-main" ? "running" : undefined,
    );

    await expect(emitAssistantTranscriptUpdate(false)).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      hasActiveRun: true,
      activeRunIds: null,
      session: {
        key: "agent:main:main",
        sessionId: "sess-main",
        hasActiveRun: true,
        activeRunIds: null,
      },
    });
    expect(resolveEmbeddedAgentSessionProgressStateMock).toHaveBeenCalledWith(
      "sess-main",
      expect.objectContaining({ agentId: "main" }),
    );
  });

  it.each([
    { name: "routes the configured persisted owner without publishing its goal" },
    { name: "publishes the explicit owner's identity and goal", agentId: "ops" },
  ])("$name", async ({ agentId }) => {
    runtimeConfigState.value = fixedStoreRuntimeConfig("ops", ["ops", "research"]);
    sessionRow.key = "global";
    const goal = { ...ownerGoal };
    loadGatewaySessionRowMock.mockReturnValue({ ...sessionRow, goal });
    const getSessionMessageSubscribers = vi.fn((sessionKey: string) =>
      sessionKey === "global"
        ? new Set(["conn-global"])
        : sessionKey === "agent:ops:global"
          ? new Set(["conn-scoped"])
          : new Set<string>(),
    );
    const broadcastToConnIds = vi.fn();
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set<string>() },
      sessionMessageSubscribers: { get: getSessionMessageSubscribers },
      chatAbortControllers: new Map(),
    });

    await handler({
      sessionKey: "global",
      ...(agentId ? { agentId } : {}),
      message: textMessage("assistant", "Owner reply"),
      messageId: "message-global-owner",
      messageSeq: 1,
    });

    expect(getSessionMessageSubscribers).toHaveBeenCalledWith("agent:ops:global");
    expect(getSessionMessageSubscribers).toHaveBeenCalledWith("global");
    expect(loadGatewaySessionRowMock).toHaveBeenCalledWith("global", {
      agentId: "ops",
    });
    expectBroadcast(
      broadcastToConnIds,
      "session.message",
      { sessionKey: "global" },
      new Set(["conn-scoped", "conn-global"]),
    );
    const payload = broadcastToConnIds.mock.calls[0]?.[1];
    if (agentId) {
      expect(payload).toMatchObject({ agentId: "ops", goal, session: { goal } });
    } else {
      expectAbsent(payload, "agentId", "goal", "session.goal");
    }
  });

  it("keeps a retired fixed-store owner private instead of routing through another agent", async () => {
    runtimeConfigState.value = fixedStoreRuntimeConfig("ops", ["research"]);
    const getSessionMessageSubscribers = vi.fn((sessionKey: string) =>
      sessionKey === "agent:ops:global"
        ? new Set(["conn-ops"])
        : sessionKey === "agent:research:global"
          ? new Set(["conn-research"])
          : new Set<string>(),
    );
    const { broadcastToConnIds, handler } = createHandler(
      false,
      true,
      getSessionMessageSubscribers,
    );

    await handler({
      sessionKey: "global",
      message: textMessage("assistant", "private owner"),
      messageId: "message-retired-owner",
      messageSeq: 1,
    });

    expect(getSessionMessageSubscribers).toHaveBeenCalledWith("agent:ops:global");
    expect(getSessionMessageSubscribers).not.toHaveBeenCalledWith("agent:research:global");
    expect(loadGatewaySessionRowMock).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledOnce();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ sessionKey: "global", phase: "message" }),
      new Set(["conn-1", "conn-ops"]),
      {
        agentId: "ops",
        dropIfSlow: true,
        sessionKeys: ["agent:ops:global"],
      },
    );
    expectPrivateSessionInvalidation(broadcastToConnIds.mock.calls[0]?.[1]);
  });

  it.each([
    [
      "broadcasts user idempotency keys in session.message metadata",
      { ...textMessage("user", "Optimistic turn"), idempotencyKey: "client-turn-3" },
      { message: { __openclaw: { id: "message-1", idempotencyKey: "client-turn-3", seq: 1 } } },
    ],
    [
      "broadcasts the authenticated sender ownership decision",
      { ...textMessage("user", "Owner turn"), __openclaw: { senderIsOwner: true } },
      { senderIsOwner: true },
    ],
  ])("%s", async (_name, message, expected) => {
    await expect(emitAssistantTranscriptUpdate(false, message)).resolves.toMatchObject(expected);
  });
  it("publishes message-phase changes to plugins without websocket subscribers", async () => {
    const received = vi.fn();
    const unsubscribe = subscribePluginSessionsChanged(received);
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(),
    });
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set() },
      sessionMessageSubscribers: { get: () => new Set() },
      chatAbortControllers: new Map(),
    });
    projectChatDisplayMessageMock.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);

    try {
      await handler(fileUpdate({ role: "toolResult", content: [] }));
      expect(received).toHaveBeenCalledOnce();
      expect(received).toHaveBeenCalledWith({
        sessionKey: "agent:main:main",
        phase: "message",
      });
    } finally {
      unsubscribe();
    }
  });

  it("reads the canonical message through the target's explicit store", async () => {
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue({ ...defaultEntry });
    readSessionMessageByIdAsyncMock.mockResolvedValueOnce(
      storedMessage("message-partial-target", 7),
    );
    const { broadcastToConnIds, handler } = createHandler(false);

    await handler({
      agentId: "main",
      message: textMessage("assistant", "Final answer"),
      messageId: "message-partial-target",
      sessionKey: "agent:main:main",
      target: {
        agentId: "main",
        sessionId: "partial-target-session",
        sessionKey: "agent:main:main",
        storePath: "/tmp/explicit-sessions.json",
      },
    });
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);

    expect(loadAccessorSessionEntryReadOnlyMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: "/tmp/explicit-sessions.json",
    });
    expect(broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({ messageSeq: 7 });
  });

  it.each([
    ["distinct session keys", "main", "agent:main:slow", "main", "agent:main:main"],
    ["global sessions owned by different agents", "main", "global", "research", "global"],
  ])(
    "does not stall %s behind another transcript's pending seq read",
    async (_name, slowAgentId, slowSessionKey, fastAgentId, fastSessionKey) => {
      const slowCount = createDeferredCore<number>();
      const readSequence = vi.fn((params: { agentId?: string; sessionKey?: string }) =>
        params.agentId === slowAgentId && params.sessionKey === slowSessionKey
          ? slowCount.promise
          : Promise.resolve(3),
      );
      readSessionMessageCountAsyncMock.mockImplementation(readSequence);
      readSessionMessageByIdAsyncMock.mockImplementation(async (scope, id: string) =>
        storedMessage(id, await readSequence(scope)),
      );
      loadAccessorSessionEntryReadOnlyMock.mockReturnValue({ sessionId: "sess-main" });
      const { broadcastToConnIds, handler } = createHandler(false);

      // No messageSeq: the slow lane blocks on its async transcript count.
      const slowTask = handler({
        message: textMessage("assistant", "slow"),
        messageId: "slow-1",
        target: {
          agentId: slowAgentId,
          sessionId: "sess-slow",
          sessionKey: slowSessionKey,
          storePath: "/tmp/slow-sessions.json",
        },
      });
      await vi.waitFor(() => expect(readSequence).toHaveBeenCalledOnce());

      const fastTask = handler(
        fileUpdate(textMessage("assistant", "fast"), {
          agentId: fastAgentId,
          sessionKey: fastSessionKey,
          messageId: "fast-1",
        }),
      );

      try {
        // The independent lane must publish while the other transcript remains parked.
        await vi.waitFor(() => expect(broadcastToConnIds).toHaveBeenCalledOnce(), {
          timeout: 100,
          interval: 5,
        });
        expect(broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({ messageId: "fast-1" });
      } finally {
        slowCount.resolve(5);
        await Promise.allSettled([slowTask, fastTask]);
      }

      expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
      expect(broadcastToConnIds.mock.calls[1]?.[1]).toMatchObject({ messageId: "slow-1" });
    },
  );

  it.each([
    ["an agent-qualified session", "agent:main:main", "agent:main:main", "main", false],
    ["an ownerless legacy global update", "global", "global", "main", false],
    [
      "a global session and its agent-qualified alias",
      "global",
      "agent:main:global",
      "main",
      false,
    ],
    [
      "a marker-only update and its canonical transcript key",
      "agent:main:main",
      "agent:main:main",
      "main",
      true,
    ],
    ["an ownerless global update in its configured fixed store", "global", "global", "ops", false],
  ] as const)(
    "preserves message order for %s",
    async (_name, firstSessionKey, secondSessionKey, agentId, markerOnly) => {
      runtimeConfigState.value =
        agentId === "ops"
          ? {
              ...fixedStoreRuntimeConfig("ops", ["ops", "research"]),
              session: { store: "/tmp/owned-shared.sqlite" },
            }
          : {};
      const firstRead = createDeferredCore<number>();
      readSessionMessageCountAsyncMock.mockImplementationOnce(() => firstRead.promise);
      readSessionMessageByIdAsyncMock.mockImplementationOnce(async (_scope, id: string) =>
        storedMessage(id, await firstRead.promise),
      );
      loadAccessorSessionEntryReadOnlyMock.mockReturnValue({ sessionId: "sess-main" });
      if (markerOnly) {
        listAccessorSessionEntriesReadOnlyMock.mockReturnValue([
          { key: firstSessionKey, entry: { sessionId: "sess-main" } },
        ]);
      }
      const { broadcastToConnIds, handler } = createHandler(false);

      const firstTask = handler({
        message: textMessage("assistant", "first"),
        messageId: "ordered-1",
        ...(markerOnly
          ? { sessionFile: `sqlite:${agentId}:sess-main:/tmp/explicit-sessions.json` }
          : {
              target: {
                agentId,
                sessionId: "sess-main",
                sessionKey: firstSessionKey,
                storePath: "/tmp/explicit-sessions.json",
              },
            }),
      });
      await vi.waitFor(() =>
        expect(
          readSessionMessageCountAsyncMock.mock.calls.length +
            readSessionMessageByIdAsyncMock.mock.calls.length,
        ).toBe(1),
      );
      const secondTask = handler(
        fileUpdate(textMessage("assistant", "second"), {
          sessionKey: secondSessionKey,
          messageId: "ordered-2",
          messageSeq: 2,
        }),
      );

      await Promise.resolve();
      await Promise.resolve();
      try {
        expect(broadcastToConnIds).not.toHaveBeenCalled();
      } finally {
        firstRead.resolve(1);
        await Promise.allSettled([firstTask, secondTask]);
      }
      expect(broadcastToConnIds.mock.calls.map((call) => call[1]?.messageId)).toEqual([
        "ordered-1",
        "ordered-2",
      ]);
    },
  );
});
