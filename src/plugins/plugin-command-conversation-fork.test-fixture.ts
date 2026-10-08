import { vi } from "vitest";

const mocks = vi.hoisted(() => {
  let current: Record<string, unknown> | null = null;
  const pendingChildren = new Map<string, string>();
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
      // SAFETY: the synthetic host supplies an optional assertion callback in bind input.
      (input.assertCurrent as (() => void) | undefined)?.();
      // SAFETY: the synthetic host supplies a conversation record for each bind.
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
    pendingChildren,
    createGatewaySession: vi.fn(async () => ({
      ok: true,
      key: "agent:main:dashboard:forked",
      agentId: "main",
      entry: { sessionId: "forked" },
      resolved: { modelProvider: "openai", model: "test" },
      resetExisting: false,
      postCommit: { status: "completed" },
    })),
    transcriptEvents: new Array<unknown>(),
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
vi.mock("./plugin-command-conversation-fork-pending.js", () => ({
  hasPendingChildPlacement: vi.fn(async (conversation: { conversationId: string }) =>
    mocks.pendingChildren.has(conversation.conversationId),
  ),
  reserveChildPlacement: vi.fn(
    async (conversation: { conversationId: string }, operationId: string) => {
      if (mocks.pendingChildren.has(conversation.conversationId)) {
        return false;
      }
      mocks.pendingChildren.set(conversation.conversationId, operationId);
      return true;
    },
  ),
  settleChildPlacement: vi.fn(
    async (conversation: { conversationId: string }, operationId: string) => {
      if (mocks.pendingChildren.get(conversation.conversationId) !== operationId) {
        return false;
      }
      mocks.pendingChildren.delete(conversation.conversationId);
      return true;
    },
  ),
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
    const { readSessionForkReplySelection: read } =
      await import("../config/sessions/session-transcript-fork-reply.js");
    // SAFETY: this synthetic worker receives the fork-selection input from the host.
    return read(input as Parameters<typeof read>[0]);
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

const { createPluginCommandConversationForkHost } =
  await import("./plugin-command-conversation-fork.js");

export const conversation = {
  channel: "telegram",
  accountId: "default",
  conversationId: "-1001234567890:topic:41",
};

export function host(activeConversation = conversation) {
  return createPluginCommandConversationForkHost({
    config: {},
    agentId: "main",
    sessionKey: "agent:main:source",
    conversation: activeConversation,
    signal: new AbortController().signal,
  });
}

export {
  mocks,
  createPluginCommandConversationForkHost as createPluginCommandConversationForkHostFixture,
};
