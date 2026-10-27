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

function messageUpdate(messageId: string, text = messageId, role = "assistant") {
  return { messageId, message: { role, content: [{ type: "text", text }] } };
}

function directUpdate(messageId: string, text = messageId, role = "assistant") {
  return {
    sessionFile: "/tmp/sess-main.jsonl",
    sessionKey: "agent:main:main",
    messageSeq: 1,
    ...messageUpdate(messageId, text, role),
  };
}

function routedHandler(routes: Record<string, string[]>, broad?: string[]) {
  const get = (key: string) => new Set(routes[key] ?? []);
  if (!broad) {
    return createHandler(false, true, get);
  }
  const broadcastToConnIds = vi.fn();
  const handler = createTranscriptUpdateBroadcastHandler({
    broadcastToConnIds,
    sessionEventSubscribers: { getAll: () => new Set(broad) },
    sessionMessageSubscribers: { get },
  });
  return { broadcastToConnIds, handler };
}

function sessionEntry(lifecycleRevision?: string) {
  return {
    sessionId: "sess-main",
    updatedAt: 1,
    ...(lifecycleRevision ? { lifecycleRevision } : {}),
  };
}

function holdMessageRead(messageId = "executing") {
  const entered = createDeferred();
  const release = createDeferred<ReturnType<typeof storedMessage>>();
  readSessionMessageByIdAsyncMock.mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  return { entered: entered.promise, release: () => release.resolve(storedMessage(messageId)) };
}

function expectMessageIds(broadcast: ReturnType<typeof vi.fn>, ids: string[]) {
  expect(broadcast.mock.calls.map((call) => call[1]?.messageId)).toEqual(ids);
}

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
    const read = holdMessageRead();
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue(sessionEntry("current"));
    const { broadcastToConnIds, handler } = createHandler(false, true, () => new Set(["targeted"]));
    const update = (messageId: string) => ({
      target: transcriptTarget("/tmp/saturated.sqlite"),
      lifecycleRevision: "current",
      messageId,
      message: { role: "user", content: messageId },
    });
    const executing = handler(update("executing"));
    await withinTest(read.entered, signal);
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
      read.release();
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
      read.release();
      await Promise.allSettled([executing, ...pending]);
    }
  });

  it("keeps saturated resets separate across same-id lifecycle replacement", async ({ signal }) => {
    const read = holdMessageRead();
    let lifecycleRevision = "before";
    loadAccessorSessionEntryReadOnlyMock.mockImplementation(() => sessionEntry(lifecycleRevision));
    const { handler, broadcastToConnIds } = createHandler(false);
    const update = (messageId: string) => ({
      target: transcriptTarget("/tmp/replaced.sqlite"),
      lifecycleRevision,
      messageId,
      message: { role: "user", content: messageId },
    });
    const executing = handler(update("executing"));
    await withinTest(read.entered, signal);
    const before = handler(update("before-1"));
    expect(handler(update("before-2"))).toBe(before);
    lifecycleRevision = "after";
    const after = handler(update("after-1"));
    expect(handler(update("after-2"))).toBe(after);
    expect(after).not.toBe(before);
    try {
      read.release();
      await withinTest(Promise.all([executing, before, after]), signal);
      expect(readSessionMessageByIdAsyncMock).toHaveBeenCalledOnce();
      expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        "sessions.changed",
        expect.objectContaining({ sessionKey: "agent:main:main", phase: "message" }),
        expect.any(Set),
        expect.objectContaining({ prepareSessionProjection: expect.any(Function) }),
      );
    } finally {
      read.release();
      await Promise.allSettled([executing, before, after]);
    }
  });

  it("reads canonical content and placement from the target's explicit store", async () => {
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue(sessionEntry());
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
      agentId: "main",
      sessionKey: "agent:main:main",
      target: {
        ...transcriptTarget("/tmp/explicit-sessions.json"),
        sessionId: "partial-target-session",
      },
      messageId: "same-id",
      messageSeq: 1,
      message: { role: "assistant", content: "stale queued content" },
    });
    expect(broadcastToConnIds).toHaveBeenCalledOnce();
    expect(loadAccessorSessionEntryReadOnlyMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: "/tmp/explicit-sessions.json",
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

  it.each(["current", "deleted"] as const)(
    "publishes identity-only invalidation only for a %s owner",
    async (owner) => {
      const { broadcastToConnIds, handler } = routedHandler(
        { "agent:main:main": ["conn-targeted", "conn-shared"] },
        ["conn-broad", "conn-shared"],
      );
      loadAccessorSessionEntryReadOnlyMock.mockReturnValue(
        owner === "current" ? sessionEntry("committed-revision") : undefined,
      );

      await handler({
        target: transcriptTarget("/tmp/identity-only-custom-sessions.json"),
        lifecycleRevision: "committed-revision",
      });

      if (owner === "current") {
        expect(broadcastToConnIds).toHaveBeenCalledOnce();
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
        expectAbsentFields(
          broadcastToConnIds.mock.calls[0]?.[1],
          "message messageId messageSeq lifecycleRevision storePath target.storePath",
        );
      } else {
        expect(broadcastToConnIds).not.toHaveBeenCalled();
      }
      expect(readSessionMessageCountAsyncMock).not.toHaveBeenCalled();
    },
  );

  it("scopes a queued marker update to its final transcript key", async () => {
    listAccessorSessionEntriesReadOnlyMock
      .mockReturnValueOnce([{ key: "agent:main:queued", entry: { sessionId: "sess-main" } }])
      .mockReturnValue([{ key: "agent:main:current", entry: { sessionId: "sess-main" } }]);
    const { broadcastToConnIds, handler } = routedHandler({
      "agent:main:current": ["conn-current"],
      "agent:main:queued": ["conn-stale"],
    });

    await handler({
      sessionFile: "sqlite:main:sess-main:/tmp/explicit-sessions.json",
    });

    expectBroadcast(
      broadcastToConnIds,
      { sessionKey: "agent:main:current" },
      "sessions.changed",
      new Set(["conn-1", "conn-current"]),
    );
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
      let currentEntry: ReturnType<typeof sessionEntry> | undefined =
        sessionEntry("revision-before-reset");
      loadAccessorSessionEntryReadOnlyMock.mockImplementation(() => currentEntry);
      loadGatewaySessionEntryReadOnlyMock.mockReturnValue({
        entry: sessionEntry("revision-before-reset"),
        storePath: "/tmp/default-lifecycle-sessions.json",
      });
      const read = holdMessageRead("message-before-reset");
      const { broadcastToConnIds, handler } = createHandler(false);

      const pendingBroadcast = handler({
        target: transcriptTarget("/tmp/reset-lifecycle-sessions.json"),
        ...(lifecycleRevision ? { lifecycleRevision } : {}),
        ...messageUpdate("message-before-reset", "deleted by reset", "user"),
      });

      await read.entered;
      expect(readSessionMessageByIdAsyncMock).toHaveBeenCalledOnce();
      if (ownerChange === "deleted") {
        currentEntry = undefined;
      } else if (ownerChange === "rebound") {
        currentEntry.sessionId = "sess-replacement";
      } else {
        currentEntry.lifecycleRevision = "revision-after-reset";
      }
      read.release();

      await pendingBroadcast;
      expect(loadGatewaySessionEntryReadOnlyMock).not.toHaveBeenCalled();
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["current-lifecycle", "current-revision"],
    ["revisionless-owner", "committed-revision"],
    ["legacy-lifecycle", undefined],
  ] as const)(
    "publishes the %s custom-store message without private identity",
    async (kind, lifecycleRevision) => {
      const messageId = `message-${kind}`;
      const current = kind === "current-lifecycle";
      const messageSeq = lifecycleRevision ? 1 : 3;
      const storePath = `/tmp/${kind}-sessions.json`;
      if (lifecycleRevision) {
        loadAccessorSessionEntryReadOnlyMock.mockReturnValue(
          sessionEntry(current ? lifecycleRevision : undefined),
        );
      }
      if (current) {
        loadGatewaySessionEntryReadOnlyMock.mockReturnValue({
          entry: sessionEntry("unrelated-default-revision"),
          storePath: "/tmp/default-lifecycle-sessions.json",
        });
      }
      readSessionMessageByIdAsyncMock.mockResolvedValueOnce(storedMessage(messageId, messageSeq));
      const { broadcastToConnIds, handler } = createHandler(false);
      await handler({
        target: transcriptTarget(storePath),
        ...(lifecycleRevision ? { lifecycleRevision, messageSeq } : {}),
        ...messageUpdate(messageId, kind, "user"),
      });
      expect(broadcastToConnIds).toHaveBeenCalledOnce();
      expectBroadcast(broadcastToConnIds, { sessionKey: "agent:main:main", messageId, messageSeq });
      if (current) {
        expect(loadGatewaySessionEntryReadOnlyMock).not.toHaveBeenCalled();
        expectAbsentFields(
          broadcastToConnIds.mock.calls[0]?.[1],
          "lifecycleRevision storePath target.storePath",
        );
      }
    },
  );

  it.each([true, false])(
    "projects terminal run ownership only after execution starts: %s",
    async (started) => {
      const { broadcastToConnIds, handler } = createHandler(true, started);
      await handler({ ...directUpdate("message-1", "Final answer"), runId: "run-before-finalize" });
      const state = { status: started ? "running" : "done", hasActiveRun: started };
      expectBroadcast(broadcastToConnIds, {
        sessionKey: "agent:main:main",
        runId: "run-before-finalize",
        messageId: "message-1",
        messageSeq: 1,
        ...state,
        session: expect.objectContaining({ key: "agent:main:main", ...state }),
      });
    },
  );

  it.each(["ultra", undefined])(
    "projects thinking state %s without picker metadata",
    async (thinkingLevel) => {
      sessionRow.thinkingLevel = thinkingLevel;
      const payload = await emitAssistantTranscriptUpdate(false);
      expect(payload).toMatchObject({
        sessionKey: "agent:main:main",
        hasActiveRun: false,
        agentStatus: null,
        observerDigest: null,
        session: {
          hasActiveRun: false,
          thinkingLevel: thinkingLevel ?? null,
          agentRuntime: { id: "openclaw" },
          agentStatus: null,
          observerDigest: null,
        },
      });
      expectAbsentFields(
        payload,
        "thinkingLevels thinkingOptions thinkingDefault session.thinkingLevels session.thinkingOptions session.thinkingDefault",
      );
    },
  );

  it.each([
    { name: "routes the configured persisted owner without publishing its goal" },
    { name: "publishes the explicit owner's identity and goal", agentId: "ops" },
  ])("$name", async ({ agentId }) => {
    runtimeConfigState.value = fixedStoreRuntimeConfig("ops", ["ops", "research"]);
    sessionRow.key = "global";
    const goal = { ...ownerGoal };
    loadGatewaySessionRowMock.mockReturnValue({ ...sessionRow, goal });
    const { broadcastToConnIds, handler } = routedHandler(
      { global: ["conn-global"], "agent:ops:global": ["conn-scoped"] },
      [],
    );

    await handler({
      sessionKey: "global",
      ...(agentId ? { agentId } : {}),
      ...messageUpdate("message-global-owner", "Owner reply"),
      messageSeq: 1,
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
    const { broadcastToConnIds, handler } = routedHandler({
      "agent:ops:global": ["conn-ops"],
      "agent:research:global": ["conn-research"],
    });

    await handler({
      sessionKey: "global",
      ...messageUpdate("message-retired-owner", "private owner"),
      messageSeq: 1,
    });

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

  it("broadcasts user message ownership", async () => {
    await expect(
      emitAssistantTranscriptUpdate(false, {
        ...messageUpdate("message-1", "User turn", "user").message,
        __openclaw: { senderIsOwner: true },
      }),
    ).resolves.toMatchObject({ senderIsOwner: true });
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
        ...directUpdate("message-1"),
        message: { role: "toolResult", content: [] },
      });
      expect(received).toHaveBeenCalledExactlyOnceWith({
        sessionKey: "agent:main:main",
        phase: "message",
      });
    } finally {
      unsubscribe();
    }
  });

  it.each([
    ["distinct session keys", "agent:main:slow", "main", "agent:main:main"],
    ["global sessions owned by different agents", "global", "research", "global"],
  ])(
    "does not stall %s behind another transcript's pending seq read",
    async (_name, slowSessionKey, fastAgentId, fastSessionKey) => {
      const slowRead = createDeferred<number>();
      const readSequence = vi.fn((params: { agentId?: string; sessionKey?: string }) =>
        params.agentId === "main" && params.sessionKey === slowSessionKey
          ? slowRead.promise
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
        ...messageUpdate("slow-1", "slow"),
        target: {
          agentId: "main",
          sessionId: "sess-slow",
          sessionKey: slowSessionKey,
          storePath: "/tmp/slow-sessions.json",
        },
      });
      await vi.waitFor(() => expect(readSequence).toHaveBeenCalledOnce());

      const fastTask = handler({
        ...directUpdate("fast-1", "fast"),
        agentId: fastAgentId,
        sessionKey: fastSessionKey,
      });

      try {
        // The independent lane must publish while the other transcript remains parked.
        await vi.waitFor(() => expect(broadcastToConnIds).toHaveBeenCalledOnce(), {
          timeout: 100,
          interval: 5,
        });
        expect(broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({ messageId: "fast-1" });
      } finally {
        slowRead.resolve(5);
        await Promise.allSettled([slowTask, fastTask]);
      }

      expectMessageIds(broadcastToConnIds, ["fast-1", "slow-1"]);
    },
  );

  it.each([
    ["an agent-qualified session", "agent:main:main", "agent:main:main", "main"],
    ["an ownerless legacy global update", "global", "global", "main"],
    ["a global session and its agent-qualified alias", "global", "agent:main:global", "main"],
    ["an ownerless global update in its configured fixed store", "global", "global", "ops"],
  ] as const)(
    "preserves message order for %s",
    async (_name, firstSessionKey, secondSessionKey, agentId) => {
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
      const { broadcastToConnIds, handler } = createHandler(false);

      const firstTask = handler({
        ...messageUpdate("ordered-1", "first"),
        target: {
          agentId,
          sessionId: "sess-main",
          sessionKey: firstSessionKey,
          storePath: "/tmp/explicit-sessions.json",
        },
      });
      await vi.waitFor(() =>
        expect(
          readSessionMessageCountAsyncMock.mock.calls.length +
            readSessionMessageByIdAsyncMock.mock.calls.length,
        ).toBe(1),
      );
      const secondTask = handler({
        ...directUpdate("ordered-2", "second"),
        sessionKey: secondSessionKey,
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
      expectMessageIds(broadcastToConnIds, ["ordered-1", "ordered-2"]);
    },
  );
});
