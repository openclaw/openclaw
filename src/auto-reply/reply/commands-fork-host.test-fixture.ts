import { isDeepStrictEqual } from "node:util";
import { vi } from "vitest";

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
      // SAFETY: the test host supplies an optional assertion callback in this fixture input.
      (input.assertCurrent as (() => void) | undefined)?.();
      // SAFETY: the test host supplies a conversation record for every bind call.
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
    transcriptEvents: new Array<unknown>(),
    forkSessionAtMessage: vi.fn(async () => ({
      status: "created",
      key: "agent:main:dashboard:reply-fork",
      entry: { sessionId: "reply-fork", lifecycleRevision: "reply-rev" },
    })),
    dispatchReplay: vi.fn(async (_input: unknown) => ({ queuedFinal: true, counts: {} })),
    resolveModel: vi.fn(async (_ctx?: unknown, _options?: unknown) => ({ text: "model reply" })),
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

// mock-isolation: Keep external session and channel side effects out of this synthetic fork flow.
vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => mocks.service,
  isSessionBindingError: (error: unknown) =>
    Boolean(error && typeof error === "object" && "code" in error),
}));

// mock-isolation: Keep external session and channel side effects out of this synthetic fork flow.
vi.mock("../../gateway/session-create-service.js", () => ({
  createGatewaySession: mocks.createGatewaySession,
}));

// mock-isolation: Keep external session and channel side effects out of this synthetic fork flow.
vi.mock("../../gateway/session-create-key.js", () => ({
  buildDashboardSessionKey: () => "agent:main:dashboard:reply-fork",
}));

// mock-isolation: Keep external session and channel side effects out of this synthetic fork flow.
vi.mock("../../gateway/server-methods/sessions-shared.js", () => ({
  loadAccessorSessionEntryForGatewayTarget: () => ({
    canonicalKey: "agent:main:source",
    sessionStoreKey: "agent:main:source",
    storePath: "/tmp/fork-test.sqlite",
    target: { agentId: "main" },
    entry: { sessionId: "source-session", lifecycleRevision: "source-rev" },
  }),
}));

// mock-isolation: Keep external session and channel side effects out of this synthetic fork flow.
vi.mock("./commands-fork-source-target.js", () => ({
  loadNativeForkSourceTarget: vi.fn(async () => ({
    canonicalKey: "agent:main:source",
    sessionStoreKey: "agent:main:source",
    storePath: "/tmp/fork-test.sqlite",
    target: { agentId: "main" },
    entry: { sessionId: "source-session", lifecycleRevision: "source-rev" },
  })),
}));

// mock-isolation: Keep external session and channel side effects out of this synthetic fork flow.
vi.mock("../../config/sessions/session-accessor.js", () => ({
  forkSessionAtMessage: mocks.forkSessionAtMessage,
}));

// mock-isolation: Keep external session and channel side effects out of this synthetic fork flow.
vi.mock("../../config/sessions/session-transcript-read-worker-runtime.js", () => ({
  readSessionForkReplySelectionInWorker: async (input: {
    replyToId: string;
    conversation: Record<string, unknown>;
    replyConversationRef?: string;
  }) => {
    for (const candidate of mocks.transcriptEvents.toReversed()) {
      // SAFETY: only the fixture's synthetic transcript entries are read here.
      const event = candidate as {
        id?: string;
        message?: {
          role?: string;
          content?: unknown;
          media?: unknown[];
          __openclaw?: {
            media?: unknown[];
            transport?: {
              messageId?: string;
              conversation?: unknown;
              conversationRef?: string;
              channel?: string;
            };
          };
        };
      };
      const message = event.message;
      const transport = message?.["__openclaw"]?.transport;
      if (
        !event.id ||
        message?.role !== "user" ||
        transport?.messageId !== input.replyToId ||
        (input.replyConversationRef
          ? transport.conversationRef !== input.replyConversationRef ||
            transport.channel !== input.conversation.channel
          : !isDeepStrictEqual(transport.conversation, input.conversation))
      ) {
        continue;
      }
      if (
        (message["__openclaw"]?.media ?? message.media)?.length ||
        (Array.isArray(message.content) &&
          message.content.some((part) => !part || part.type !== "text"))
      ) {
        return { status: "media" };
      }
      const text =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                // SAFETY: synthetic text parts in this fixture always carry string text.
                .map((part) => part.text as string)
                .join("")
            : "";
      return text.trim() ? { status: "found", entryId: event.id, text } : { status: "missing" };
    }
    return { status: "missing" };
  },
}));

// mock-isolation: Keep external session and channel side effects out of this synthetic fork flow.
vi.mock("../../sessions/session-lifecycle-admission.js", () => ({
  isCompetingSessionWorkAdmissionActive: () => false,
  runExclusiveSessionLifecycleMutation: async (
    _operation: string,
    params: { run: () => Promise<void> },
  ) => await params.run(),
}));

// mock-isolation: Keep external session and channel side effects out of this synthetic fork flow.
vi.mock("../../sessions/session-created.js", () => ({
  recordSessionCreated: mocks.recordSessionCreated,
}));

// mock-isolation: Keep external session and channel side effects out of this synthetic fork flow.
vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: mocks.dispatchReplay,
}));

// mock-isolation: Keep external session and channel side effects out of this synthetic fork flow.
vi.mock("../../auto-reply/reply/route-reply.js", () => ({
  routeReply: mocks.routeReply,
}));

// mock-isolation: Keep external session and channel side effects out of this synthetic fork flow.
vi.mock("./get-reply.js", () => ({
  getReplyFromConfig: mocks.resolveModel,
}));

const { createNativeConversationForkHost: createForkHost } =
  await import("./commands-fork-host.js");

export function createUnassertedNativeConversationForkHost(
  params: Parameters<typeof createForkHost>[0],
) {
  return createForkHost(params);
}

export function createNativeConversationForkHostFixture(
  params: Parameters<typeof createForkHost>[0],
) {
  return createForkHost({
    ...params,
    assertOwnerCurrent: params.assertOwnerCurrent ?? (() => {}),
  });
}

export { mocks };

export const conversation = {
  channel: "telegram",
  accountId: "default",
  conversationId: "room:topic:source",
};

export function host(activeConversation = conversation) {
  return createNativeConversationForkHostFixture({
    config: {},
    agentId: "main",
    sessionKey: "agent:main:source",
    conversation: activeConversation,
    signal: new AbortController().signal,
  });
}
