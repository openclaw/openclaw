import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.js";
import { buildTestCtx } from "./reply/test-ctx.js";
import type { ReplyPayload } from "./types.js";

type DispatchReplyFromConfigFn =
  typeof import("./reply/dispatch-from-config.js").dispatchReplyFromConfig;
type FinalizeInboundContextFn = typeof import("./reply/inbound-context.js").finalizeInboundContext;
type DeriveInboundMessageHookContextFn =
  typeof import("../hooks/message-hook-mappers.js").deriveInboundMessageHookContext;
type GetGlobalHookRunnerFn = typeof import("../plugins/hook-runner-global.js").getGlobalHookRunner;
type CreateReplyDispatcherFn = typeof import("./reply/reply-dispatcher.js").createReplyDispatcher;
type CreateReplyDispatcherWithTypingFn =
  typeof import("./reply/reply-dispatcher.js").createReplyDispatcherWithTyping;

const hoisted = vi.hoisted(() => ({
  dispatchReplyFromConfigMock: vi.fn(),
  finalizeInboundContextMock: vi.fn((ctx: unknown, _opts?: unknown) => ctx),
  deriveInboundMessageHookContextMock: vi.fn(),
  getGlobalHookRunnerMock: vi.fn(),
  createReplyDispatcherMock: vi.fn(),
  createReplyDispatcherWithTypingMock: vi.fn(),
}));

vi.mock("./reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: (...args: Parameters<DispatchReplyFromConfigFn>) =>
    hoisted.dispatchReplyFromConfigMock(...args),
}));

vi.mock("./reply/inbound-context.js", () => ({
  finalizeInboundContext: (...args: Parameters<FinalizeInboundContextFn>) =>
    hoisted.finalizeInboundContextMock(...args),
}));

vi.mock("../hooks/message-hook-mappers.js", () => ({
  deriveInboundMessageHookContext: (...args: Parameters<DeriveInboundMessageHookContextFn>) =>
    hoisted.deriveInboundMessageHookContextMock(...args),
  toPluginMessageContext: (canonical: {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
  }) => ({
    channelId: canonical.channelId,
    accountId: canonical.accountId,
    conversationId: canonical.conversationId,
  }),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: (...args: Parameters<GetGlobalHookRunnerFn>) =>
    hoisted.getGlobalHookRunnerMock(...args),
}));

vi.mock("./reply/reply-dispatcher.js", async () => {
  const actual = await vi.importActual<typeof import("./reply/reply-dispatcher.js")>(
    "./reply/reply-dispatcher.js",
  );
  return {
    ...actual,
    createReplyDispatcher: (...args: Parameters<CreateReplyDispatcherFn>) =>
      hoisted.createReplyDispatcherMock(...args),
    createReplyDispatcherWithTyping: (...args: Parameters<CreateReplyDispatcherWithTypingFn>) =>
      hoisted.createReplyDispatcherWithTypingMock(...args),
  };
});

const {
  dispatchInboundMessage,
  dispatchInboundMessageWithDispatcher,
  dispatchInboundMessageWithBufferedDispatcher,
  withReplyDispatcher,
} = await import("./dispatch.js");

function createDispatcher(record: string[]): ReplyDispatcher {
  return {
    sendToolResult: () => true,
    sendBlockReply: () => true,
    sendFinalReply: () => true,
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {
      record.push("markComplete");
    },
    waitForIdle: async () => {
      record.push("waitForIdle");
    },
  };
}

function lastTypingDispatcherOptions(): Parameters<CreateReplyDispatcherWithTypingFn>[0] {
  const calls = hoisted.createReplyDispatcherWithTypingMock.mock.calls;
  const [options] = calls[calls.length - 1] ?? [];
  if (!options) {
    throw new Error("expected createReplyDispatcherWithTyping call");
  }
  return options as Parameters<CreateReplyDispatcherWithTypingFn>[0];
}

function requireReplyDispatcherOptions(index = 0): Parameters<CreateReplyDispatcherFn>[0] {
  const call = hoisted.createReplyDispatcherMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected createReplyDispatcher call ${index}`);
  }
  return call[0] as Parameters<CreateReplyDispatcherFn>[0];
}

describe("withReplyDispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.finalizeInboundContextMock.mockImplementation((ctx: unknown) => ctx);
    hoisted.deriveInboundMessageHookContextMock.mockReturnValue({
      channelId: "threads",
      accountId: "acct-1",
      conversationId: "conv-1",
      isGroup: false,
      to: "thread:1",
    });
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn(() => false),
      runMessageSending: vi.fn(async () => undefined),
    });
  });

  it("dispatchInboundMessage owns dispatcher lifecycle", async () => {
    const order: string[] = [];
    const dispatcher = {
      sendToolResult: () => true,
      sendBlockReply: () => true,
      sendFinalReply: () => {
        order.push("sendFinalReply");
        return true;
      },
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      markComplete: () => {
        order.push("markComplete");
      },
      waitForIdle: async () => {
        order.push("waitForIdle");
      },
    } satisfies ReplyDispatcher;
    hoisted.dispatchReplyFromConfigMock.mockImplementationOnce(async ({ dispatcher }) => {
      dispatcher.sendFinalReply({ text: "ok" });
      return { text: "ok" };
    });

    await dispatchInboundMessage({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });

  it("emits message.received diagnostics before dispatch", async () => {
    const events: Array<{ type: string; channel?: string; sessionKey?: string; source?: string }> =
      [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const dispatcher = createDispatcher([]);
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });

    try {
      await dispatchInboundMessage({
        ctx: buildTestCtx({
          Provider: "signal",
          Surface: "signal",
          SessionKey: "agent:main:signal:direct:u1",
        }),
        cfg: {} as OpenClawConfig,
        dispatcher,
      });
    } finally {
      stop();
      resetDiagnosticEventsForTest();
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message.received",
        channel: "signal",
        sessionKey: "agent:main:signal:direct:u1",
        source: "dispatchInboundMessage",
      }),
    );
  });

  it("always marks complete and waits for idle after success", async () => {
    const order: string[] = [];
    const dispatcher = createDispatcher(order);

    const result = await withReplyDispatcher({
      dispatcher,
      run: async () => {
        order.push("run");
        return "ok";
      },
      onSettled: () => {
        order.push("onSettled");
      },
    });

    expect(result).toBe("ok");
    expect(order).toEqual(["run", "markComplete", "waitForIdle", "onSettled"]);
  });

  it("still drains dispatcher after run throws", async () => {
    const order: string[] = [];
    const dispatcher = createDispatcher(order);
    const onSettled = vi.fn(() => {
      order.push("onSettled");
    });

    await expect(
      withReplyDispatcher({
        dispatcher,
        run: async () => {
          order.push("run");
          throw new Error("boom");
        },
        onSettled,
      }),
    ).rejects.toThrow("boom");

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["run", "markComplete", "waitForIdle", "onSettled"]);
  });

  it("dispatchInboundMessageWithBufferedDispatcher cleans up typing after a resolver starts it", async () => {
    const typing = {
      onReplyStart: vi.fn(async () => {}),
      startTypingLoop: vi.fn(async () => {}),
      startTypingOnText: vi.fn(async () => {}),
      refreshTypingTtl: vi.fn(),
      isActive: vi.fn(() => true),
      markRunComplete: vi.fn(),
      markDispatchIdle: vi.fn(),
      cleanup: vi.fn(),
    };
    hoisted.createReplyDispatcherWithTypingMock.mockReturnValueOnce({
      dispatcher: createDispatcher([]),
      replyOptions: {},
      markDispatchIdle: typing.markDispatchIdle,
      markRunComplete: typing.markRunComplete,
    });
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({ text: "ok" });

    await dispatchInboundMessageWithBufferedDispatcher({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: {
        deliver: async () => undefined,
      },
      replyResolver: async (_ctx, opts) => {
        opts?.onTypingController?.(typing);
        return { text: "ok" };
      },
    });

    expect(typing.markRunComplete).toHaveBeenCalledTimes(1);
    expect(typing.markDispatchIdle).toHaveBeenCalledTimes(1);
  });

  it("runs message_sending hooks before inbound dispatcher delivery", async () => {
    const runMessageSending = vi.fn(async () => ({ content: "sanitized reply" }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName?: string) => hookName === "message_sending"),
      runMessageSending,
    });
    hoisted.createReplyDispatcherMock.mockReturnValueOnce(createDispatcher([]));
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({ text: "ok" });

    await dispatchInboundMessageWithDispatcher({
      ctx: buildTestCtx({
        From: "whatsapp:+15551234567",
        To: "whatsapp:+15557654321",
        OriginatingTo: "whatsapp:+15551234567",
      }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: {
        deliver: async () => undefined,
      },
      replyResolver: async () => ({ text: "ok" }),
    });

    const dispatcherOptions = requireReplyDispatcherOptions();
    if (!dispatcherOptions?.beforeDeliver) {
      throw new Error("expected beforeDeliver hook");
    }

    const payload = await dispatcherOptions.beforeDeliver(
      { text: "original reply" },
      { kind: "final" },
    );

    expect(payload).toEqual({ text: "sanitized reply" });
    expect(runMessageSending).toHaveBeenCalledWith(
      { content: "original reply", to: "whatsapp:+15551234567" },
      {
        channelId: "threads",
        accountId: "acct-1",
        conversationId: "conv-1",
      },
    );
  });

  // Gap 8: the buffered dispatcher path (used by the Telegram channel via
  // dispatchReplyWithBufferedBlockDispatcher) must COMPOSE the canonical
  // message_sending gate with any channel-supplied beforeDeliver — canonical
  // first — rather than letting the channel's beforeDeliver override it. The
  // Telegram channel passes an identity no-op `beforeDeliver` (bot-message-
  // dispatch.ts); under the old `??` wiring that silently discarded the gate,
  // so message_sending never fired for interactive replies.
  type ChannelBeforeDeliver = (payload: ReplyPayload) => Promise<ReplyPayload | null>;

  const runBufferedDispatch = async (opts: {
    runMessageSending: ReturnType<typeof vi.fn>;
    channelBeforeDeliver?: ChannelBeforeDeliver;
  }) => {
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName?: string) => hookName === "message_sending"),
      runMessageSending: opts.runMessageSending,
    });
    hoisted.createReplyDispatcherWithTypingMock.mockReturnValueOnce({
      dispatcher: createDispatcher([]),
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
    });
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({ text: "ok" });

    await dispatchInboundMessageWithBufferedDispatcher({
      ctx: buildTestCtx({ From: "telegram:1155284475", To: "telegram:1155284475" }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: {
        ...(opts.channelBeforeDeliver ? { beforeDeliver: opts.channelBeforeDeliver } : {}),
        deliver: async () => undefined,
      },
      replyResolver: async () => ({ text: "ok" }),
    });

    const beforeDeliver = lastTypingDispatcherOptions().beforeDeliver;
    if (!beforeDeliver) {
      throw new Error("expected a composed beforeDeliver on the buffered dispatcher");
    }
    return beforeDeliver;
  };

  it("fires message_sending when no channel beforeDeliver is supplied (baseline)", async () => {
    const runMessageSending = vi.fn(async () => ({ content: "sanitized reply" }));
    const beforeDeliver = await runBufferedDispatch({ runMessageSending });
    const payload = await beforeDeliver({ text: "original reply" }, { kind: "final" });
    expect(runMessageSending).toHaveBeenCalledTimes(1);
    expect(payload).toEqual({ text: "sanitized reply" });
  });

  it("Gap 8 regression: fires message_sending exactly once even when the channel supplies a no-op beforeDeliver", async () => {
    const runMessageSending = vi.fn(async () => ({ content: "sanitized reply" }));
    // The live Telegram channel (bot-message-dispatch.ts) passes this identity no-op.
    const beforeDeliver = await runBufferedDispatch({
      runMessageSending,
      channelBeforeDeliver: async (payload) => payload,
    });
    const payload = await beforeDeliver({ text: "original reply" }, { kind: "final" });
    expect(runMessageSending).toHaveBeenCalledTimes(1);
    expect(payload).toEqual({ text: "sanitized reply" });
  });

  it("composes canonical-first: the channel beforeDeliver sees the gated payload", async () => {
    const runMessageSending = vi.fn(async () => ({ content: "sanitized reply" }));
    const channelSaw: string[] = [];
    const beforeDeliver = await runBufferedDispatch({
      runMessageSending,
      channelBeforeDeliver: async (payload) => {
        channelSaw.push(payload.text ?? "");
        return { ...payload, text: `${payload.text} [ch]` };
      },
    });
    const payload = await beforeDeliver({ text: "original reply" }, { kind: "final" });
    // Canonical gate ran first (sanitized the model output); the channel transform
    // then saw the gated payload; the final reply reflects both, canonical-first.
    expect(channelSaw).toEqual(["sanitized reply"]);
    expect(payload).toEqual({ text: "sanitized reply [ch]" });
  });

  it("canonical veto is terminal: a message_sending cancel skips the channel beforeDeliver", async () => {
    const runMessageSending = vi.fn(async () => ({ cancel: true }));
    const channelBeforeDeliver = vi.fn(async (payload: ReplyPayload) => payload);
    const beforeDeliver = await runBufferedDispatch({ runMessageSending, channelBeforeDeliver });
    const payload = await beforeDeliver({ text: "original reply" }, { kind: "final" });
    expect(payload).toBeNull();
    expect(channelBeforeDeliver).not.toHaveBeenCalled();
  });

  it("channel veto is terminal: a null from the channel beforeDeliver cancels delivery after gating", async () => {
    const runMessageSending = vi.fn(async () => undefined); // canonical passes the payload through
    const beforeDeliver = await runBufferedDispatch({
      runMessageSending,
      channelBeforeDeliver: async () => null,
    });
    const payload = await beforeDeliver({ text: "original reply" }, { kind: "final" });
    expect(runMessageSending).toHaveBeenCalledTimes(1);
    expect(payload).toBeNull();
  });

  it("reconciles queuedFinal and counts after dispatcher-side cancellation", async () => {
    const dispatcher = {
      sendToolResult: () => true,
      sendBlockReply: () => true,
      sendFinalReply: () => true,
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      getCancelledCounts: () => ({ tool: 0, block: 0, final: 1 }),
      getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      markComplete: () => undefined,
      waitForIdle: async () => undefined,
    } satisfies ReplyDispatcher;
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });

    const result = await dispatchInboundMessage({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
  });

  it("reconciles queuedFinal and counts after dispatcher-side delivery failure", async () => {
    const dispatcher = {
      sendToolResult: () => true,
      sendBlockReply: () => true,
      sendFinalReply: () => true,
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      getCancelledCounts: () => ({ tool: 0, block: 0, final: 0 }),
      getFailedCounts: () => ({ tool: 0, block: 0, final: 1 }),
      markComplete: () => undefined,
      waitForIdle: async () => undefined,
    } satisfies ReplyDispatcher;
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });

    const result = await dispatchInboundMessage({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      failedCounts: { tool: 0, block: 0, final: 1 },
    });
  });

  it("uses CommandTargetSessionKey for silent-reply policy on native command turns", async () => {
    hoisted.createReplyDispatcherWithTypingMock.mockReturnValueOnce({
      dispatcher: createDispatcher([]),
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
    });
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({ text: "ok" });

    await dispatchInboundMessageWithBufferedDispatcher({
      ctx: buildTestCtx({
        SessionKey: "agent:test:telegram:slash:8231046597",
        CommandSource: "native",
        CommandTargetSessionKey: "agent:test:telegram:direct:8231046597",
        Surface: "telegram",
      }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: {
        deliver: async () => undefined,
      },
      replyResolver: async () => ({ text: "ok" }),
    });

    const dispatcherOptions = lastTypingDispatcherOptions();
    expect(dispatcherOptions.silentReplyContext?.sessionKey).toBe(
      "agent:test:telegram:direct:8231046597",
    );
    expect(dispatcherOptions.silentReplyContext?.surface).toBe("telegram");
  });

  it("passes explicit direct conversation type for generic silent-reply policy keys", async () => {
    hoisted.createReplyDispatcherWithTypingMock.mockReturnValueOnce({
      dispatcher: createDispatcher([]),
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
    });
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({ text: "ok" });

    await dispatchInboundMessageWithBufferedDispatcher({
      ctx: buildTestCtx({
        SessionKey: "agent:test:main",
        ChatType: "dm",
        Surface: "discord",
      }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: {
        deliver: async () => undefined,
      },
      replyResolver: async () => ({ text: "ok" }),
    });

    const dispatcherOptions = lastTypingDispatcherOptions();
    expect(dispatcherOptions.silentReplyContext?.sessionKey).toBe("agent:test:main");
    expect(dispatcherOptions.silentReplyContext?.surface).toBe("discord");
    expect(dispatcherOptions.silentReplyContext?.conversationType).toBe("direct");
  });

  it("does not copy source conversation type onto cross-session native silent-reply targets", async () => {
    hoisted.createReplyDispatcherWithTypingMock.mockReturnValueOnce({
      dispatcher: createDispatcher([]),
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
    });
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({ text: "ok" });

    await dispatchInboundMessageWithBufferedDispatcher({
      ctx: buildTestCtx({
        SessionKey: "agent:test:main",
        CommandSource: "native",
        CommandTargetSessionKey: "agent:test:direct:user",
        ChatType: "group",
        Surface: "telegram",
      }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: {
        deliver: async () => undefined,
      },
      replyResolver: async () => ({ text: "ok" }),
    });

    const dispatcherOptions = lastTypingDispatcherOptions();
    expect(dispatcherOptions.silentReplyContext?.sessionKey).toBe("agent:test:direct:user");
    expect(dispatcherOptions.silentReplyContext?.surface).toBe("telegram");
    expect(dispatcherOptions.silentReplyContext?.conversationType).not.toBe("group");
  });
});
