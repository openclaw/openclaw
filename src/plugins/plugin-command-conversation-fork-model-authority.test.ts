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

describe("plugin conversation fork replay model authority", () => {
  beforeEach(() => {
    mocks.current = null;
    mocks.transcriptEvents = [];
    vi.clearAllMocks();
  });

  it.each(["owner", "binding"] as const)(
    "retains the %s replay fence through async model preparation",
    async (change) => {
      let authorized = true;
      let modelStarted = false;
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
        const replay = input as { replyResolver: () => Promise<unknown> };
        await replay.replyResolver();
        return { queuedFinal: true, counts: {} };
      });
      mocks.getReplyFromConfig.mockImplementationOnce(async (_ctx: unknown, options: unknown) => {
        const fence = (options as { assertForkReplaySourceCurrent?: () => void })
          .assertForkReplaySourceCurrent;
        expect(fence).toBeTypeOf("function");
        await Promise.resolve(); // Async reply preparation can outlive resolver entry.
        if (change === "owner") {
          authorized = false;
        } else {
          mocks.current = { ...mocks.current, generation: crypto.randomUUID() };
        }
        fence?.(); // The run-admission/model/tool boundary uses this same callback.
        modelStarted = true;
        return { text: "must not run" };
      });
      const runtime = createPluginCommandConversationForkHost({
        config: {},
        agentId: "main",
        sessionKey: "agent:main:source",
        conversation,
        replyToId: "telegram-41",
        signal: new AbortController().signal,
        assertOwnerCurrent: () => {
          if (!authorized) {
            throw new Error("owner revoked");
          }
        },
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
      expect(modelStarted).toBe(false);
      expect(mocks.routeReply).not.toHaveBeenCalled();
    },
  );
});
