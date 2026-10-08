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
      (input.assertCurrent as (() => void) | undefined)?.();
      const conversation = input.conversation as Record<string, unknown>;
      const record = {
        bindingId: "binding-1",
        generation: crypto.randomUUID(),
        targetSessionKey: input.targetSessionKey,
        targetKind: input.targetKind,
        conversation:
          input.placement === "child"
            ? { ...conversation, conversationId: "-1001234567890:topic:99" }
            : conversation,
        status: "active",
        boundAt: Date.now(),
        metadata: input.metadata,
      };
      current = record;
      return record;
    }),
    unbind: vi.fn(async (input: { assertCurrent?: () => void }) => {
      input.assertCurrent?.();
      const removed = current;
      current = null;
      return removed ? [removed] : [];
    }),
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
    getReplyFromConfig: vi.fn(async (..._args: unknown[]) => ({ text: "model output" })),
    routeReply: vi.fn(async (_input: unknown) => ({ ok: true, delivered: true })),
    recordSessionCreated: vi.fn(),
    get current() {
      return current;
    },
    set current(value) {
      current = value;
    },
  };
});

// mock-isolation: Keep stateful Gateway, session, and channel effects synthetic for this fork contract test.
vi.mock("../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => mocks.service,
  isSessionBindingError: (error: unknown) =>
    Boolean(error && typeof error === "object" && "code" in error),
}));

// mock-isolation: Keep stateful Gateway, session, and channel effects synthetic for this fork contract test.
vi.mock("../gateway/session-create-service.js", () => ({
  createGatewaySession: mocks.createGatewaySession,
  buildDashboardSessionKey: () => "agent:main:dashboard:reply-fork",
}));

// mock-isolation: Keep stateful Gateway, session, and channel effects synthetic for this fork contract test.
vi.mock("../gateway/session-utils-store-worker.js", () => ({
  resolveGatewaySessionStoreTargetInWorker: async () => ({
    agentId: "main",
    canonicalKey: "agent:main:source",
    storePath: "/tmp/fork-test.sqlite",
    storeKeys: ["agent:main:source"],
    store: {
      "agent:main:source": { sessionId: "source-session", lifecycleRevision: "source-rev" },
    },
  }),
}));

// mock-isolation: Keep stateful Gateway, session, and channel effects synthetic for this fork contract test.
vi.mock("../config/sessions/session-accessor.js", () => ({
  forkSessionAtMessage: mocks.forkSessionAtMessage,
}));

// mock-isolation: Keep stateful Gateway, session, and channel effects synthetic for this fork contract test.
vi.mock("../config/sessions/session-accessor.sqlite-active-events.js", () => ({
  readRecentSessionTranscriptActiveEvents: () => mocks.transcriptEvents,
}));

// mock-isolation: Keep stateful Gateway, session, and channel effects synthetic for this fork contract test.
vi.mock("../config/sessions/session-transcript-read-worker-runtime.js", () => ({
  readSessionForkReplySelectionInWorker: async (input: unknown) => {
    const { readSessionForkReplySelection } =
      await import("../config/sessions/session-transcript-fork-reply.js");
    return readSessionForkReplySelection(
      input as Parameters<typeof readSessionForkReplySelection>[0],
    );
  },
}));

// mock-isolation: Keep stateful Gateway, session, and channel effects synthetic for this fork contract test.
vi.mock("../sessions/session-lifecycle-admission.js", () => ({
  isCompetingSessionWorkAdmissionActive: () => false,
  runExclusiveSessionLifecycleMutation: async (
    _operation: string,
    params: { run: () => Promise<void> },
  ) => await params.run(),
}));

// mock-isolation: Keep stateful Gateway, session, and channel effects synthetic for this fork contract test.
vi.mock("../sessions/session-created.js", () => ({
  recordSessionCreated: mocks.recordSessionCreated,
}));

// mock-isolation: Keep stateful Gateway, session, and channel effects synthetic for this fork contract test.
vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: mocks.dispatchReplay,
}));

// mock-isolation: Keep stateful Gateway, session, and channel effects synthetic for this fork contract test.
vi.mock("../auto-reply/reply/get-reply-from-config.runtime.js", () => ({
  getReplyFromConfig: mocks.getReplyFromConfig,
}));

// mock-isolation: Keep stateful Gateway, session, and channel effects synthetic for this fork contract test.
vi.mock("../auto-reply/reply/route-reply.js", () => ({
  routeReply: mocks.routeReply,
}));

import { createPluginCommandConversationForkHost } from "./plugin-command-conversation-fork.js";

const conversation = {
  channel: "telegram",
  accountId: "default",
  conversationId: "-1001234567890:topic:41",
};

describe("plugin fork route lifecycle", () => {
  beforeEach(() => {
    mocks.current = null;
    mocks.transcriptEvents = [];
    vi.clearAllMocks();
  });

  it("lets a queued replay use the live owner and route after command invocation closes", async () => {
    const command = new AbortController();
    let queuedResolver: (() => Promise<unknown>) | undefined;
    let queuedDeliver: ((payload: unknown, info: { kind: string }) => Promise<unknown>) | undefined;
    mocks.transcriptEvents = [
      {
        id: "entry",
        message: {
          role: "user",
          content: "branch",
          __openclaw: { transport: { messageId: "telegram-41", conversation } },
        },
      },
    ];
    mocks.dispatchReplay.mockImplementationOnce(async (input: unknown) => {
      const replay = input as {
        replyResolver: () => Promise<unknown>;
        dispatcherOptions: {
          deliver: (payload: unknown, info: { kind: string }) => Promise<unknown>;
        };
      };
      queuedResolver = replay.replyResolver;
      queuedDeliver = replay.dispatcherOptions.deliver;
      return { queuedFinal: true, counts: {} };
    });
    mocks.routeReply.mockImplementationOnce(async (input: unknown) => {
      const route = input as {
        abortSignal?: AbortSignal;
        assertDirectAdapterHandoff?: () => void;
      };
      if (route.abortSignal?.aborted) {
        return { ok: false, delivered: false, error: "Reply routing aborted" };
      }
      route.assertDirectAdapterHandoff?.();
      return { ok: true, delivered: true };
    });
    const runtime = createPluginCommandConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-41",
      signal: command.signal,
      assertOwnerCurrent: () => undefined,
    });
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({
      status: "placed",
      replay: "submitted",
    });
    command.abort("command invocation closed");
    expect(queuedResolver).toBeDefined();
    await expect(queuedResolver!()).resolves.toEqual({ text: "model output" });
    expect(queuedDeliver).toBeDefined();
    await expect(queuedDeliver!({ text: "model output" }, { kind: "final" })).resolves.toEqual({
      visibleReplySent: true,
    });
    expect(mocks.getReplyFromConfig).toHaveBeenCalledOnce();
    expect(mocks.routeReply).toHaveBeenCalledOnce();
    expect(mocks.routeReply.mock.calls[0]?.[0]).not.toHaveProperty("abortSignal");
  });

  it("keeps replay authorized after its own binding activity refresh", async () => {
    mocks.transcriptEvents = [
      {
        id: "entry",
        message: {
          role: "user",
          content: "branch",
          __openclaw: { transport: { messageId: "telegram-41", conversation } },
        },
      },
    ];
    mocks.dispatchReplay.mockImplementationOnce(async (input: unknown) => {
      const current = mocks.current;
      if (!current) {
        throw new Error("expected placed binding");
      }
      mocks.current = {
        ...current,
        expiresAt: Date.now() + 60_000,
        metadata: { ...(current.metadata as Record<string, unknown>), lastActivityAt: Date.now() },
      };
      const replay = input as {
        replyResolver: () => Promise<unknown>;
        dispatcherOptions: {
          deliver: (payload: unknown, info: { kind: string }) => Promise<unknown>;
        };
      };
      await replay.replyResolver();
      await replay.dispatcherOptions.deliver({ text: "fork answer" }, { kind: "final" });
      return { queuedFinal: true, counts: {} };
    });
    const runtime = createPluginCommandConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-41",
      signal: new AbortController().signal,
      assertOwnerCurrent: () => undefined,
    });
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({
      status: "placed",
      replay: "submitted",
    });
    expect(mocks.getReplyFromConfig).toHaveBeenCalledOnce();
    expect(mocks.routeReply).toHaveBeenCalledOnce();
  });

  it("rejects changed fork receipt metadata even when route generation stays the same", async () => {
    mocks.transcriptEvents = [
      {
        id: "entry",
        message: {
          role: "user",
          content: "branch",
          __openclaw: { transport: { messageId: "telegram-41", conversation } },
        },
      },
    ];
    mocks.dispatchReplay.mockImplementationOnce(async (input: unknown) => {
      const current = mocks.current;
      if (!current) {
        throw new Error("expected placed binding");
      }
      const metadata = current.metadata as Record<string, unknown>;
      mocks.current = {
        ...current,
        metadata: {
          ...metadata,
          conversationFork: {
            ...(metadata.conversationFork as Record<string, unknown>),
            sourceSessionKey: "agent:other:source",
          },
        },
      };
      await (input as { replyResolver: () => Promise<unknown> }).replyResolver();
      return { queuedFinal: true, counts: {} };
    });
    const runtime = createPluginCommandConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-41",
      signal: new AbortController().signal,
      assertOwnerCurrent: () => undefined,
    });
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({
      status: "placed",
      replay: "ambiguous",
    });
    expect(mocks.getReplyFromConfig).not.toHaveBeenCalled();
    expect(mocks.routeReply).not.toHaveBeenCalled();
  });

  it("returns from a Telegram child after the binding store omits its inferable topic parent", async () => {
    const source = { ...conversation, parentConversationId: "-1001234567890" };
    const child = { ...source, conversationId: "-1001234567890:topic:99" };
    const hostFor = (activeConversation: typeof source) =>
      createPluginCommandConversationForkHost({
        config: {},
        agentId: "main",
        sessionKey: "agent:main:source",
        conversation: activeConversation,
        signal: new AbortController().signal,
        assertOwnerCurrent: () => undefined,
      });
    const runtime = hostFor(source);
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "child" }),
    ).resolves.toMatchObject({
      status: "placed",
      placement: "child",
      returnReady: true,
    });
    const placed = mocks.current;
    if (!placed) {
      throw new Error("expected child binding");
    }
    mocks.current = {
      ...placed,
      conversation: {
        ...(placed.conversation as Record<string, unknown>),
        parentConversationId: undefined,
      },
    };
    await expect(hostFor(child).back()).resolves.toMatchObject({
      status: "returned",
      mode: "navigate",
    });
    mocks.current = {
      ...placed,
      conversation: {
        ...(placed.conversation as Record<string, unknown>),
        parentConversationId: "-100wrong",
      },
    };
    await expect(hostFor(child).back()).resolves.toEqual({ status: "no_previous" });
  });
});
