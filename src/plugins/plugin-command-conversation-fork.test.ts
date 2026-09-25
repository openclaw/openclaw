import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let current: Record<string, unknown> | null = null;
  const service = {
    getCapabilities: vi.fn(() => ({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    })),
    resolveByConversation: vi.fn(() => current),
    resolveByConversationAsync: vi.fn(async () => current),
    bind: vi.fn(async (input: Record<string, unknown>) => {
      const conversation = input.conversation as Record<string, unknown>;
      const record = {
        bindingId: "binding-1",
        generation: crypto.randomUUID(),
        targetSessionKey: input.targetSessionKey,
        targetKind: input.targetKind,
        conversation:
          input.placement === "child"
            ? { ...conversation, conversationId: "room:topic:created" }
            : conversation,
        status: "active",
        boundAt: Date.now(),
        metadata: input.metadata,
      };
      current = record;
      return record;
    }),
    unbind: vi.fn(async () => []),
  };
  return {
    service,
    createGatewaySession: vi.fn(async () => ({
      ok: true,
      key: "agent:main:dashboard:forked",
      agentId: "main",
      entry: { sessionId: "forked" },
      resolved: { modelProvider: "openai", model: "test" },
      resetExisting: false,
      postCommit: { status: "completed" },
    })),
    transcriptEvents: [] as unknown[],
    forkSessionAtMessage: vi.fn(async () => ({
      status: "created",
      key: "agent:main:dashboard:reply-fork",
      entry: { sessionId: "reply-fork", lifecycleRevision: "reply-rev" },
    })),
    dispatchReplay: vi.fn(async (_input: unknown) => ({ queuedFinal: true, counts: {} })),
    recordSessionCreated: vi.fn(),
    get current() {
      return current;
    },
    set current(value) {
      current = value;
    },
  };
});

vi.mock("../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => mocks.service,
  isSessionBindingError: (error: unknown) =>
    Boolean(error && typeof error === "object" && "code" in error),
}));

vi.mock("../gateway/session-create-service.js", () => ({
  createGatewaySession: mocks.createGatewaySession,
  buildDashboardSessionKey: () => "agent:main:dashboard:reply-fork",
}));

vi.mock("../gateway/server-methods/sessions-shared.js", () => ({
  loadAccessorSessionEntryForGatewayTarget: () => ({
    canonicalKey: "agent:main:source",
    sessionStoreKey: "agent:main:source",
    storePath: "/tmp/fork-test.sqlite",
    target: { agentId: "main" },
    entry: { sessionId: "source-session", lifecycleRevision: "source-rev" },
  }),
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  readRecentSessionTranscriptActiveEvents: () => mocks.transcriptEvents,
  forkSessionAtMessage: mocks.forkSessionAtMessage,
}));

vi.mock("../sessions/session-lifecycle-admission.js", () => ({
  isCompetingSessionWorkAdmissionActive: () => false,
  runExclusiveSessionLifecycleMutation: async (params: { run: () => Promise<void> }) =>
    await params.run(),
}));

vi.mock("../sessions/session-created.js", () => ({
  recordSessionCreated: mocks.recordSessionCreated,
}));

vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: mocks.dispatchReplay,
}));

vi.mock("../auto-reply/reply/route-reply.js", () => ({
  routeReply: vi.fn(async () => ({ ok: true, delivered: true })),
}));

import { createPluginCommandConversationForkHost } from "./plugin-command-conversation-fork.js";

const conversation = {
  channel: "telegram",
  accountId: "default",
  conversationId: "room:topic:source",
};

function host() {
  return createPluginCommandConversationForkHost({
    config: {},
    agentId: "main",
    sessionKey: "agent:main:source",
    conversation,
    signal: new AbortController().signal,
  });
}

describe("plugin command conversation fork host", () => {
  beforeEach(() => {
    mocks.current = null;
    mocks.transcriptEvents = [];
    vi.clearAllMocks();
  });

  it("prepares and places a tip fork in a child conversation", async () => {
    const runtime = host();
    const plan = await runtime.prepare({ title: "Tangent" });
    expect(plan).toMatchObject({ status: "ready", child: true, current: true, source: "tip" });
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "child" }),
    ).resolves.toMatchObject({
      status: "placed",
      placement: "child",
      replay: "none",
      conversationId: "room:topic:created",
    });
    expect(mocks.createGatewaySession).toHaveBeenCalledWith(
      expect.objectContaining({ parentSessionKey: "agent:main:source", fork: true }),
    );
  });

  it("restores the source route when the fork replaced an unbound conversation", async () => {
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await runtime.execute({ ticket: plan.ticket, placement: "current" });
    await expect(host().back()).resolves.toEqual({
      status: "returned",
      mode: "restored",
      shared: true,
    });
    expect(mocks.service.bind).toHaveBeenLastCalledWith(
      expect.objectContaining({
        targetSessionKey: "agent:main:source",
        placement: "current",
      }),
    );
  });

  it("reuses a prepared session when child placement fails before current fallback", async () => {
    mocks.service.bind
      .mockRejectedValueOnce({ code: "BINDING_CREATE_FAILED" })
      .mockImplementationOnce(async (input: Record<string, unknown>) => {
        // SAFETY: the production bind contract always supplies a normalized conversation record.
        const boundConversation = input.conversation as Record<string, unknown>;
        const record = {
          bindingId: "binding-current",
          generation: crypto.randomUUID(),
          targetSessionKey: input.targetSessionKey,
          targetKind: input.targetKind,
          conversation: boundConversation,
          status: "active",
          boundAt: Date.now(),
          metadata: input.metadata,
        };
        mocks.current = record;
        return record;
      });
    const runtime = host();
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "child" }),
    ).resolves.toMatchObject({ status: "not_placed", effect: "session_only" });
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({ status: "placed", placement: "current" });
    expect(mocks.createGatewaySession).toHaveBeenCalledTimes(1);
  });

  it("rejects a retained host after invocation closure", async () => {
    const controller = new AbortController();
    const runtime = createPluginCommandConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      signal: controller.signal,
    });
    controller.abort();
    await expect(runtime.prepare()).rejects.toThrow();
    await expect(runtime.status()).rejects.toThrow();
  });

  it("maps a native reply id, forks before that prompt, and submits it once", async () => {
    mocks.transcriptEvents = [
      {
        id: "entry-user-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "Take the other path" }],
          transport: { messageId: "telegram-41" },
        },
      },
    ];
    const runtime = createPluginCommandConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-41",
      signal: new AbortController().signal,
    });
    const plan = await runtime.prepare();
    expect(plan).toMatchObject({ status: "ready", source: "reply" });
    if (plan.status !== "ready") {
      throw new Error("expected reply plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({ status: "placed", source: "reply", replay: "submitted" });
    expect(mocks.forkSessionAtMessage).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: "entry-user-1" }),
      expect.any(Object),
    );
    expect(mocks.dispatchReplay).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchReplay.mock.calls[0]?.[0]).toMatchObject({
      ctx: {
        Body: "Take the other path",
        SessionKey: "agent:main:dashboard:reply-fork",
      },
    });
  });

  it("refuses media reply replay until the host can preserve media exactly once", async () => {
    mocks.transcriptEvents = [
      {
        id: "entry-user-media",
        message: {
          role: "user",
          content: "Describe this",
          transport: { messageId: "telegram-media-1" },
          media: [{ type: "image", url: "file:///tmp/example.png" }],
        },
      },
    ];
    const runtime = createPluginCommandConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-media-1",
      signal: new AbortController().signal,
    });
    await expect(runtime.prepare()).resolves.toEqual({
      status: "blocked",
      reason: "media_unavailable",
    });
    expect(mocks.forkSessionAtMessage).not.toHaveBeenCalled();
    expect(mocks.dispatchReplay).not.toHaveBeenCalled();
  });
});
