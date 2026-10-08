import { isDeepStrictEqual } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";

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
    transcriptEvents: [] as unknown[],
    sourceIncognito: false,
    forkSessionAtMessage: vi.fn(async () => ({
      status: "created",
      key: "agent:main:dashboard:reply-fork",
      entry: { sessionId: "reply-fork", lifecycleRevision: "reply-rev" },
    })),
    forkSessionAtMessageDirect: vi.fn(async () => ({
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
    entry: {
      sessionId: "source-session",
      lifecycleRevision: "source-rev",
      incognito: mocks.sourceIncognito,
    },
  }),
}));

// mock-isolation: Keep external session and channel side effects out of this synthetic fork flow.
vi.mock("./commands-fork-source-target.js", () => ({
  loadNativeForkSourceTarget: vi.fn(async () => ({
    canonicalKey: "agent:main:source",
    sessionStoreKey: "agent:main:source",
    storePath: "/tmp/fork-test.sqlite",
    target: { agentId: "main" },
    entry: {
      sessionId: "source-session",
      lifecycleRevision: "source-rev",
      incognito: mocks.sourceIncognito,
    },
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
            ? message.content.map((part) => part.text as string).join("")
            : "";
      return text.trim() ? { status: "found", entryId: event.id, text } : { status: "missing" };
    }
    return { status: "missing" };
  },
}));

// The host lifetime test stubs reply selection; the process-held SQLite boundary is
// exercised without mocks in session-transcript-fork-reply.test.ts.
// mock-isolation: Keep external session and channel side effects out of this synthetic fork flow.
vi.mock("../../config/sessions/session-transcript-fork-reply.js", () => ({
  readSessionForkReplySelection: async (
    input: Parameters<
      typeof import("../../config/sessions/session-transcript-read-worker-runtime.js").readSessionForkReplySelectionInWorker
    >[0],
  ) =>
    await (
      await import("../../config/sessions/session-transcript-read-worker-runtime.js")
    ).readSessionForkReplySelectionInWorker(input),
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

import { createNativeConversationForkHost as createForkHost } from "./commands-fork-host.js";

function createNativeConversationForkHost(params: Parameters<typeof createForkHost>[0]) {
  return createForkHost({
    ...params,
    assertOwnerCurrent: params.assertOwnerCurrent ?? (() => {}),
  });
}

const conversation = {
  channel: "telegram",
  accountId: "default",
  conversationId: "room:topic:source",
};

function host(
  activeConversation: Parameters<typeof createForkHost>[0]["conversation"] = conversation,
) {
  return createNativeConversationForkHost({
    config: {},
    agentId: "main",
    sessionKey: "agent:main:source",
    conversation: activeConversation,
    signal: new AbortController().signal,
  });
}

describe("native conversation fork replay lifetime", () => {
  beforeEach(() => {
    mocks.current = null;
    mocks.transcriptEvents = [];
    mocks.sourceIncognito = false;
    vi.clearAllMocks();
  });

  it("rejects Matrix before creating a session because its adapter cannot fence placement", async () => {
    await expect(host({ ...conversation, channel: "matrix" }).prepare()).resolves.toEqual({
      status: "blocked",
      reason: "unsupported",
    });
    expect(mocks.createGatewaySession).not.toHaveBeenCalled();
  });

  it("uses the native owner only for an in-memory incognito reply fork", async () => {
    mocks.sourceIncognito = true;
    mocks.transcriptEvents = [
      {
        id: "entry-user-1",
        message: {
          role: "user",
          content: "Private tangent",
          __openclaw: {
            transport: {
              messageId: "telegram-private-1",
              channel: "telegram",
              conversationRef: "ref:source",
            },
          },
        },
      },
    ];
    const runtime = createNativeConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-private-1",
      replyConversationRef: "ref:source",
      signal: new AbortController().signal,
    });
    const plan = await runtime.prepare();
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") {
      throw new Error("expected reply plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({ status: "placed", source: "reply" });
    expect(mocks.forkSessionAtMessage).toHaveBeenCalledTimes(1);
  });

  it("consumes a reply ticket when the worker cut outcome is unknown", async () => {
    mocks.transcriptEvents = [
      {
        id: "entry-user-1",
        message: {
          role: "user",
          content: "Branch here",
          __openclaw: {
            transport: {
              messageId: "telegram-reply-1",
              channel: "telegram",
              conversationRef: "ref:source",
            },
          },
        },
      },
    ];
    mocks.forkSessionAtMessage.mockRejectedValueOnce(
      new SqliteWorkerError("worker result lost after cut", "outcome-unknown"),
    );
    const runtime = createNativeConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-reply-1",
      replyConversationRef: "ref:source",
      signal: new AbortController().signal,
      assertOwnerCurrent: () => {},
    });
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected reply plan");
    }
    await expect(runtime.execute({ ticket: plan.ticket, placement: "current" })).rejects.toThrow(
      "worker result lost",
    );
    await expect(runtime.execute({ ticket: plan.ticket, placement: "current" })).resolves.toEqual({
      status: "blocked",
      reason: "unauthorized",
    });
    expect(mocks.forkSessionAtMessage).toHaveBeenCalledTimes(1);
    expect(mocks.service.bind).not.toHaveBeenCalled();
  });

  it("returns from a Telegram child after persisted projection omits its parent", async () => {
    const initial = host();
    const plan = await initial.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected ready plan");
    }
    await initial.execute({ ticket: plan.ticket, placement: "child" });
    mocks.current = {
      ...(mocks.current as Record<string, unknown>),
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-100999001:topic:22",
      },
    };
    const topic = {
      channel: "telegram",
      accountId: "default",
      conversationId: "-100999001:topic:22",
    };
    await expect(
      host({ ...topic, parentConversationId: "-100999001" }).back(),
    ).resolves.toMatchObject({
      status: "returned",
      mode: "navigate",
    });
    await expect(host({ ...topic, parentConversationId: "-100777000" }).back()).resolves.toEqual({
      status: "no_previous",
    });
  });

  it("keeps an accepted queued replay live after its command signal closes", async () => {
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
    let queuedResolver: (() => Promise<unknown>) | undefined;
    mocks.dispatchReplay.mockImplementationOnce(async (input: unknown) => {
      queuedResolver = (input as { replyResolver: () => Promise<unknown> }).replyResolver;
      return { queuedFinal: true, counts: {} };
    });
    const command = new AbortController();
    const runtime = createNativeConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-41",
      signal: command.signal,
    });
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected reply plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({
      status: "placed",
      replay: "submitted",
    });
    command.abort();
    if (!queuedResolver) {
      throw new Error("expected queued resolver");
    }
    await expect(queuedResolver()).resolves.toMatchObject({ text: "model reply" });
    expect(mocks.resolveModel).toHaveBeenCalledTimes(1);
  });

  it("keeps replay authorized across activity and idle-expiry refreshes", async () => {
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
      const current = mocks.current;
      if (!current) {
        throw new Error("expected fork binding");
      }
      mocks.current = {
        ...current,
        expiresAt: Date.now() + 60_000,
        metadata: { ...(current.metadata as object), lastActivityAt: Date.now() + 1 },
      };
      await replay.replyResolver();
      await replay.dispatcherOptions.deliver({ text: "branch answer" }, { kind: "final" });
      return { queuedFinal: true, counts: {} };
    });
    const runtime = createNativeConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation,
      replyToId: "telegram-41",
      signal: new AbortController().signal,
    });
    const plan = await runtime.prepare();
    if (plan.status !== "ready") {
      throw new Error("expected reply plan");
    }
    await expect(
      runtime.execute({ ticket: plan.ticket, placement: "current" }),
    ).resolves.toMatchObject({
      status: "placed",
      replay: "submitted",
    });
    expect(mocks.resolveModel).toHaveBeenCalledTimes(1);
    expect(mocks.routeReply).toHaveBeenCalledTimes(1);
  });

  it.each(["owner", "binding"] as const)(
    "carries replay %s authority into delayed model admission",
    async (change) => {
      let authorized = true;
      let providerTouched = false;
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
      mocks.resolveModel.mockImplementationOnce(async (_ctx: unknown, options: unknown) => {
        await Promise.resolve();
        if (change === "owner") {
          authorized = false;
        } else {
          mocks.current = { ...mocks.current, generation: crypto.randomUUID() };
        }
        const replayOptions = options as { assertForkReplaySourceCurrent?: () => void };
        if (!replayOptions.assertForkReplaySourceCurrent) {
          throw new Error("replay source fence missing");
        }
        replayOptions.assertForkReplaySourceCurrent();
        providerTouched = true;
        return { text: "must not execute" };
      });
      const runtime = createNativeConversationForkHost({
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
        throw new Error("expected reply plan");
      }
      await expect(
        runtime.execute({ ticket: plan.ticket, placement: "current" }),
      ).resolves.toMatchObject({
        status: "placed",
        replay: "ambiguous",
      });
      expect(providerTouched).toBe(false);
      expect(mocks.routeReply).not.toHaveBeenCalled();
    },
  );
});
