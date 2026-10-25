import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { registerTranscriptMarkerQueueTests } from "./server-session-events.marker-queue.test-support.js";
import {
  createGatewayBroadcaster,
  createHandler,
  createTranscriptUpdateBroadcastHandler,
  emitAssistantTranscriptUpdate,
  expectAbsentFields,
  expectBroadcast,
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
  resetSessionEventMocks,
  runtimeConfigState,
  sessionRow,
  storedMessage,
  subscribePluginSessionsChanged,
  transcriptTarget,
} from "./server-session-events.test-support.js";
import { GatewayClientRegistry } from "./server/client-registry.js";

describe("createTranscriptUpdateBroadcastHandler", () => {
  beforeEach(() => {
    resetSessionEventMocks();
    readSessionMessageByIdAsyncMock.mockImplementation(async (_scope, id: string) =>
      storedMessage(id),
    );
    sessionRow.thinkingLevel = "ultra";
  });

  it("bounds queued presentation behind a held canonical read and invalidates history", async ({
    signal,
  }) => {
    const entered = createDeferred();
    const release = createDeferred();
    readSessionMessageByIdAsyncMock.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return storedMessage("executing");
    });
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue({
      sessionId: "sess-main",
      lifecycleRevision: "current",
      updatedAt: 1,
    });
    const { broadcastToConnIds, handler } = createHandler(false, true, () => new Set(["targeted"]));
    const update = (messageId: string) => ({
      target: transcriptTarget("/tmp/saturated.sqlite"),
      lifecycleRevision: "current",
      messageId,
      message: { role: "user", content: messageId },
    });
    const executing = handler(update("executing"));
    await withinTest(entered.promise, signal);
    const pending = Array.from({ length: 1000 }, (_, index) => handler(update(String(index))));
    let settled = false;
    void pending[0]!.then(() => {
      settled = true;
    });
    try {
      // Admission shares a pending publication, not a promise chain per notification.
      expect(new Set(pending).size).toBe(1);
      expect(settled).toBe(false);
      const independent = handler({
        sessionKey: "agent:main:independent",
        messageId: "independent",
        messageSeq: 1,
        message: { role: "user", content: "independent" },
      });
      await withinTest(independent, signal);
      expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
      release.resolve();
      const [executed, ...collapsed] = await withinTest(
        Promise.all([executing, ...pending]),
        signal,
      );
      expect(executed).toBeUndefined();
      expect(collapsed.every((result) => result === false)).toBe(true);
      expect(readSessionMessageByIdAsyncMock).toHaveBeenCalledOnce();
      expect(broadcastToConnIds.mock.calls.map(([event]) => event)).toEqual([
        "session.message",
        "session.message",
        "sessions.changed",
      ]);
      expect(broadcastToConnIds.mock.calls[2]?.[2]).toEqual(new Set(["conn-1", "targeted"]));
      expect(broadcastToConnIds.mock.calls[2]?.[1]).not.toHaveProperty("messageId");
    } finally {
      release.resolve();
      await Promise.allSettled([executing, ...pending]);
    }
  });

  it("keeps saturated resets separate across same-id lifecycle replacement", async ({ signal }) => {
    const entered = createDeferred();
    const release = createDeferred();
    let lifecycleRevision = "before";
    loadAccessorSessionEntryReadOnlyMock.mockImplementation(() => ({
      sessionId: "sess-main",
      lifecycleRevision,
      updatedAt: 1,
    }));
    readSessionMessageByIdAsyncMock.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return storedMessage("executing");
    });
    const { handler, broadcastToConnIds } = createHandler(false);
    const update = (messageId: string) => ({
      target: transcriptTarget("/tmp/replaced.sqlite"),
      lifecycleRevision,
      messageId,
      message: { role: "user", content: messageId },
    });
    const executing = handler(update("executing"));
    await withinTest(entered.promise, signal);
    const before = handler(update("before-1"));
    expect(handler(update("before-2"))).toBe(before);
    lifecycleRevision = "after";
    const after = handler(update("after-1"));
    expect(handler(update("after-2"))).toBe(after);
    expect(after).not.toBe(before);
    try {
      release.resolve();
      await withinTest(Promise.all([executing, before, after]), signal);
      expect(readSessionMessageByIdAsyncMock).toHaveBeenCalledOnce();
      expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        "sessions.changed",
        expect.objectContaining({ sessionKey: "agent:main:main", phase: "message" }),
        expect.any(Set),
        expect.objectContaining({ prepareSessionProjection: expect.any(Function) }),
      );
    } finally {
      release.resolve();
      await Promise.allSettled([executing, before, after]);
    }
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
    const { broadcastToConnIds, handler } = createHandler(false);
    await handler({
      target: transcriptTarget("/tmp/canonical-update.sqlite"),
      messageId: "same-id",
      messageSeq: 1,
      message: { role: "assistant", content: "stale queued content" },
    });
    expectBroadcast(broadcastToConnIds, {
      messageId: "same-id",
      messageSeq: 7,
      message: expect.objectContaining({
        content: "replacement",
        __openclaw: expect.objectContaining({ transcriptPosition }),
      }),
    });
  });

  it("never silently drops an authoritative session message for a slow subscriber", async () => {
    const { broadcastToConnIds, handler } = createHandler(false);

    await handler({
      sessionFile: "/tmp/sess-main.jsonl",
      sessionKey: "agent:main:main",
      message: { role: "user", content: [{ type: "text", text: "shared durable prompt" }] },
      messageId: "durable-user-1",
      messageSeq: 1,
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expectBroadcast(broadcastToConnIds, {
      sessionKey: "agent:main:main",
      messageId: "durable-user-1",
      messageSeq: 1,
    });
  });

  it("invalidates broad and targeted subscribers once for an identity-only commit", async () => {
    const broadConnIds = new Set(["conn-broad", "conn-shared"]);
    const targetConnIds = new Set(["conn-targeted", "conn-shared"]);
    const getSessionMessageSubscribers = vi.fn((sessionKey: string) =>
      sessionKey === "agent:main:main" ? targetConnIds : new Set<string>(),
    );
    const broadcastToConnIds = vi.fn();
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue({
      sessionId: "sess-main",
      lifecycleRevision: "committed-revision",
      updatedAt: 1,
    });
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => broadConnIds },
      sessionMessageSubscribers: { get: getSessionMessageSubscribers },
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
      {
        sessionKey: "agent:main:main",
        agentId: "main",
        sessionId: "sess-main",
        phase: "message",
      },
      "sessions.changed",
      new Set(["conn-broad", "conn-shared", "conn-targeted"]),
    );
    const payload = broadcastToConnIds.mock.calls[0]?.[1];
    expectAbsentFields(
      payload,
      "message messageId messageSeq lifecycleRevision storePath target.storePath",
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
      { sessionKey: "agent:main:current" },
      "sessions.changed",
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
  ] as const)(
    "discards a queued %s message when its session owner is %s",
    async (_source, ownerChange, lifecycleRevision) => {
      let currentEntry:
        | { sessionId: string; lifecycleRevision: string; updatedAt: number }
        | undefined = {
        sessionId: "sess-main",
        lifecycleRevision: "revision-before-reset",
        updatedAt: 1,
      };
      loadAccessorSessionEntryReadOnlyMock.mockImplementation(() => currentEntry);
      loadGatewaySessionEntryReadOnlyMock.mockReturnValue({
        entry: {
          sessionId: "sess-main",
          lifecycleRevision: "revision-before-reset",
          updatedAt: 1,
        },
        storePath: "/tmp/default-lifecycle-sessions.json",
      });
      let resolveMessageRead: ((value: ReturnType<typeof storedMessage>) => void) | undefined;
      readSessionMessageByIdAsyncMock.mockImplementation(
        () =>
          new Promise<ReturnType<typeof storedMessage>>((resolve) => {
            resolveMessageRead = resolve;
          }),
      );
      const { broadcastToConnIds, handler } = createHandler(false);

      const pendingBroadcast = handler({
        target: transcriptTarget("/tmp/reset-lifecycle-sessions.json"),
        ...(lifecycleRevision ? { lifecycleRevision } : {}),
        message: { role: "user", content: [{ type: "text", text: "deleted by reset" }] },
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
      resolveMessageRead?.(storedMessage("message-before-reset"));

      await pendingBroadcast;
      expect(loadGatewaySessionEntryReadOnlyMock).not.toHaveBeenCalled();
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["current-lifecycle", "current-revision", "message-current-lifecycle", "current prompt"],
    [
      "revisionless-owner",
      "committed-revision",
      "revisionless-owner-message",
      "revisionless owner",
    ],
    ["legacy-lifecycle", undefined, "legacy-lifecycle-message", "legacy prompt"],
  ] as const)(
    "publishes the %s custom-store message without private identity",
    async (kind, lifecycleRevision, messageId, text) => {
      const current = kind === "current-lifecycle";
      const messageSeq = lifecycleRevision ? 1 : 3;
      const storePath = `/tmp/${kind}-sessions.json`;
      if (lifecycleRevision) {
        loadAccessorSessionEntryReadOnlyMock.mockReturnValue({
          sessionId: "sess-main",
          updatedAt: 1,
          ...(current ? { lifecycleRevision } : {}),
        });
      }
      if (current) {
        loadGatewaySessionEntryReadOnlyMock.mockReturnValue({
          entry: {
            sessionId: "sess-main",
            lifecycleRevision: "unrelated-default-revision",
            updatedAt: 1,
          },
          storePath: "/tmp/default-lifecycle-sessions.json",
        });
      }
      readSessionMessageByIdAsyncMock.mockResolvedValueOnce(storedMessage(messageId, messageSeq));
      const { broadcastToConnIds, handler } = createHandler(false);
      await handler({
        target: transcriptTarget(storePath),
        ...(lifecycleRevision ? { lifecycleRevision, messageSeq } : {}),
        message: { role: "user", content: [{ type: "text", text }] },
        messageId,
      });
      expect(broadcastToConnIds).toHaveBeenCalledOnce();
      expectBroadcast(broadcastToConnIds, { sessionKey: "agent:main:main", messageId, messageSeq });
      if (current) {
        expect(loadAccessorSessionEntryReadOnlyMock).toHaveBeenCalledWith({
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath,
        });
        expect(loadGatewaySessionEntryReadOnlyMock).not.toHaveBeenCalled();
        expectAbsentFields(
          broadcastToConnIds.mock.calls[0]?.[1],
          "lifecycleRevision storePath target.storePath",
        );
      }
    },
  );

  it("carries terminal assistant run ownership while plugin finalization keeps the run active", async () => {
    // before_agent_finalize hooks run after the assistant transcript write but
    // before terminal delivery. The active-run registry remains authoritative
    // during that interval even when the persisted session row says done.
    const { broadcastToConnIds, handler } = createHandler(true);

    await handler({
      sessionFile: "/tmp/sess-main.jsonl",
      sessionKey: "agent:main:main",
      runId: "run-before-finalize",
      message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
      messageId: "message-1",
      messageSeq: 1,
    });

    expectBroadcast(broadcastToConnIds, {
      sessionKey: "agent:main:main",
      runId: "run-before-finalize",
      messageId: "message-1",
      messageSeq: 1,
      status: "running",
      hasActiveRun: true,
      session: expect.objectContaining({
        key: "agent:main:main",
        status: "running",
        hasActiveRun: true,
      }),
    });
  });

  it("does not project a prepared source as a running startup transcript", async () => {
    await expect(emitAssistantTranscriptUpdate(true, undefined, false)).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      status: "done",
      hasActiveRun: false,
      session: { key: "agent:main:main", status: "done", hasActiveRun: false },
    });
  });

  it("keeps stable thinking state without catalog-derived picker metadata", async () => {
    const payload = await emitAssistantTranscriptUpdate(false);

    expect(payload).toMatchObject({
      sessionKey: "agent:main:main",
      hasActiveRun: false,
      session: {
        hasActiveRun: false,
        thinkingLevel: "ultra",
        agentRuntime: { id: "openclaw" },
      },
    });
    expectAbsentFields(
      payload,
      "thinkingLevels thinkingOptions thinkingDefault session.thinkingLevels session.thinkingOptions session.thinkingDefault",
    );
  });

  it("emits explicit tombstones in transcript snapshots", async () => {
    sessionRow.thinkingLevel = undefined;

    await expect(emitAssistantTranscriptUpdate(false)).resolves.toMatchObject({
      agentStatus: null,
      observerDigest: null,
      session: { thinkingLevel: null, agentStatus: null, observerDigest: null },
    });
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
    });

    await handler({
      sessionKey: "global",
      ...(agentId ? { agentId } : {}),
      message: { role: "assistant", content: [{ type: "text", text: "Owner reply" }] },
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
      { sessionKey: "global" },
      "session.message",
      new Set(["conn-scoped", "conn-global"]),
    );
    const payload = broadcastToConnIds.mock.calls[0]?.[1];
    if (agentId) {
      expect(payload).toMatchObject({ agentId: "ops", goal, session: { goal } });
    } else {
      expectAbsentFields(payload, "agentId goal session.goal");
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
      message: { role: "assistant", content: [{ type: "text", text: "private owner" }] },
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
        sessionEventSubscriptionKeys: ["agent:ops:global"],
      },
    );
    expectPrivateSessionInvalidation(broadcastToConnIds.mock.calls[0]?.[1]);
  });

  it("broadcasts user idempotency keys in session.message metadata", async () => {
    await expect(
      emitAssistantTranscriptUpdate(false, {
        role: "user",
        content: [{ type: "text", text: "Optimistic turn" }],
        idempotencyKey: "client-turn-3",
      }),
    ).resolves.toMatchObject({
      message: {
        __openclaw: {
          id: "message-1",
          idempotencyKey: "client-turn-3",
          seq: 1,
        },
      },
    });
  });

  it("broadcasts the authenticated sender ownership decision", async () => {
    await expect(
      emitAssistantTranscriptUpdate(false, {
        role: "user",
        content: [{ type: "text", text: "Owner turn" }],
        __openclaw: { senderIsOwner: true },
      }),
    ).resolves.toMatchObject({
      senderIsOwner: true,
    });
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
    });
    projectChatDisplayMessageMock.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);

    try {
      await handler({
        sessionFile: "/tmp/sess-main.jsonl",
        sessionKey: "agent:main:main",
        message: { role: "toolResult", content: [] },
        messageId: "message-1",
        messageSeq: 1,
      });
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
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue({
      sessionId: "sess-main",
      updatedAt: 1,
    });
    readSessionMessageByIdAsyncMock.mockResolvedValueOnce(
      storedMessage("message-partial-target", 7),
    );
    const { broadcastToConnIds, handler } = createHandler(false);

    await handler({
      agentId: "main",
      message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
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
    ["distinct session keys", "agent:main:slow", "main", "agent:main:main"],
    ["global sessions owned by different agents", "global", "research", "global"],
  ])(
    "does not stall %s behind another transcript's pending seq read",
    async (_name, slowSessionKey, fastAgentId, fastSessionKey) => {
      let releaseSlowCount: (value: number) => void = () => undefined;
      const readSequence = vi.fn((params: { agentId?: string; sessionKey?: string }) =>
        params.agentId === "main" && params.sessionKey === slowSessionKey
          ? new Promise<number>((resolve) => {
              releaseSlowCount = resolve;
            })
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
        message: { role: "assistant", content: [{ type: "text", text: "slow" }] },
        messageId: "slow-1",
        target: {
          agentId: "main",
          sessionId: "sess-slow",
          sessionKey: slowSessionKey,
          storePath: "/tmp/slow-sessions.json",
        },
      });
      await vi.waitFor(() => expect(readSequence).toHaveBeenCalledOnce());

      const fastTask = handler({
        sessionFile: "/tmp/sess-main.jsonl",
        agentId: fastAgentId,
        sessionKey: fastSessionKey,
        message: { role: "assistant", content: [{ type: "text", text: "fast" }] },
        messageId: "fast-1",
        messageSeq: 1,
      });

      try {
        // The independent lane must publish while the other transcript remains parked.
        await vi.waitFor(() => expect(broadcastToConnIds).toHaveBeenCalledOnce(), {
          timeout: 100,
          interval: 5,
        });
        expect(broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({ messageId: "fast-1" });
      } finally {
        releaseSlowCount(5);
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
      const { promise: firstRead, resolve: releaseFirstCount } = createDeferred<number>();
      readSessionMessageCountAsyncMock.mockImplementationOnce(() => firstRead);
      readSessionMessageByIdAsyncMock.mockImplementationOnce(async (_scope, id: string) =>
        storedMessage(id, await firstRead),
      );
      loadAccessorSessionEntryReadOnlyMock.mockReturnValue({ sessionId: "sess-main" });
      if (markerOnly) {
        listAccessorSessionEntriesReadOnlyMock.mockReturnValue([
          { key: firstSessionKey, entry: { sessionId: "sess-main" } },
        ]);
      }
      const { broadcastToConnIds, handler } = createHandler(false);

      const firstTask = handler({
        message: { role: "assistant", content: [{ type: "text", text: "first" }] },
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
      const secondTask = handler({
        sessionFile: "/tmp/sess-main.jsonl",
        sessionKey: secondSessionKey,
        message: { role: "assistant", content: [{ type: "text", text: "second" }] },
        messageId: "ordered-2",
        messageSeq: 2,
      });

      await Promise.resolve();
      await Promise.resolve();
      try {
        expect(broadcastToConnIds).not.toHaveBeenCalled();
      } finally {
        releaseFirstCount(1);
        await Promise.allSettled([firstTask, secondTask]);
      }
      expect(broadcastToConnIds.mock.calls.map((call) => call[1]?.messageId)).toEqual([
        "ordered-1",
        "ordered-2",
      ]);
    },
  );
});
