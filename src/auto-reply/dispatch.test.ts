/** Tests inbound dispatch hook composition, diagnostics, and dispatcher integration. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { markSuccessfulNativeDelivery } from "../infra/outbound/message-sent-hook.js";
import { registerReplyDispatcherSettledTask } from "./dispatch-dispatcher.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "./reply-payload.js";
import type { ReplyDispatchBeforeDeliver } from "./reply/reply-dispatcher.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.types.js";
import { buildTestCtx } from "./reply/test-ctx.js";

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
  buildCanonicalSentMessageHookContext: (canonical: unknown) => canonical,
  deriveInboundMessageHookContext: (...args: Parameters<DeriveInboundMessageHookContextFn>) =>
    hoisted.deriveInboundMessageHookContextMock(...args),
  toInternalMessageSentContext: (canonical: unknown) => canonical,
  toPluginMessageContext: (canonical: {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
  }) => ({
    channelId: canonical.channelId,
    accountId: canonical.accountId,
    conversationId: canonical.conversationId,
  }),
  toPluginMessageSentEvent: (canonical: unknown) => canonical,
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
const { recordReplyUsageState } = await import("./reply/reply-usage-state.js");

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
      runReplyPayloadSending: vi.fn(async () => undefined),
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
    hoisted.dispatchReplyFromConfigMock.mockImplementationOnce(
      async ({ dispatcher: dispatcherLocal }) => {
        dispatcherLocal.sendFinalReply({ text: "ok" });
        return { text: "ok" };
      },
    );

    await dispatchInboundMessage({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcher,
      onSettled: () => {
        order.push("onSettled");
      },
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle", "onSettled"]);
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
    registerReplyDispatcherSettledTask(dispatcher, () => {
      order.push("settledTask");
    });

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
    expect(order).toEqual(["run", "markComplete", "waitForIdle", "settledTask", "onSettled"]);
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

  it("composes channel and dispatcher typing-controller observers", async () => {
    const dispatcherObserver = vi.fn();
    const channelObserver = vi.fn();
    hoisted.createReplyDispatcherWithTypingMock.mockReturnValueOnce({
      dispatcher: createDispatcher([]),
      replyOptions: { onTypingController: dispatcherObserver },
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
    });
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });

    await dispatchInboundMessageWithBufferedDispatcher({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: { deliver: async () => undefined },
      replyOptions: { onTypingController: channelObserver },
    });

    const typingController = {} as never;
    const dispatchParams = hoisted.dispatchReplyFromConfigMock.mock.calls[0]?.[0];
    dispatchParams?.replyOptions?.onTypingController?.(typingController);
    expect(dispatcherObserver).toHaveBeenCalledWith(typingController);
    expect(channelObserver).toHaveBeenCalledWith(typingController);
  });

  it("passes runtime toolsAllow from buffered dispatch into reply resolution", async () => {
    hoisted.createReplyDispatcherWithTypingMock.mockReturnValueOnce({
      dispatcher: createDispatcher([]),
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
    });
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });

    await dispatchInboundMessageWithBufferedDispatcher({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      toolsAllow: ["message"],
      dispatcherOptions: {
        deliver: async () => undefined,
      },
    });

    const params = hoisted.dispatchReplyFromConfigMock.mock.calls[0]?.[0];
    expect(params?.replyOptions?.toolsAllow).toEqual(["message"]);
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

    expect(payload).toMatchObject({ text: "sanitized reply" });
    const payloadWithMetadata = await dispatcherOptions.beforeDeliver(
      setReplyPayloadMetadata(
        {
          text: "original reply",
          mediaUrl: "https://example.com/a.png",
          mediaUrls: [" https://example.com/a.png ", "", "https://example.com/a.png"],
        },
        { assistantMessageIndex: 3 },
      ),
      { kind: "block" },
    );
    expect(payloadWithMetadata ? getReplyPayloadMetadata(payloadWithMetadata) : undefined).toEqual({
      assistantMessageIndex: 3,
      outboundHookLifecycle: {
        state: "prepared",
        preparedMediaCount: 1,
      },
    });
    expect(runMessageSending).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "original reply",
        to: "whatsapp:+15551234567",
        metadata: expect.objectContaining({ channel: "whatsapp", accountId: "acct-1" }),
      }),
      {
        channelId: "whatsapp",
        accountId: "acct-1",
        conversationId: "whatsapp:+15551234567",
      },
    );
  });

  it("runs message_sending for spoken media without adding visible text", async () => {
    const runMessageSending = vi.fn(async () => ({ content: "sanitized speech" }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName?: string) => hookName === "message_sending"),
      runMessageSending,
    });
    hoisted.createReplyDispatcherMock.mockReturnValueOnce(createDispatcher([]));
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({ text: "ok" });

    await dispatchInboundMessageWithDispatcher({
      ctx: buildTestCtx({ Surface: "telegram", SessionKey: "agent:test:session" }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: { deliver: async () => undefined },
    });

    const beforeDeliver = requireReplyDispatcherOptions().beforeDeliver;
    if (!beforeDeliver) {
      throw new Error("expected beforeDeliver hook");
    }
    const payload = await beforeDeliver(
      {
        spokenText: "original speech",
        mediaUrl: "https://example.com/voice.mp3",
        audioAsVoice: true,
      },
      { kind: "final" },
    );

    expect(payload).toMatchObject({
      spokenText: "sanitized speech",
      mediaUrl: "https://example.com/voice.mp3",
      audioAsVoice: true,
    });
    expect(payload).not.toHaveProperty("text");
    expect(runMessageSending).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "original speech",
        metadata: expect.objectContaining({ mediaUrls: ["https://example.com/voice.mp3"] }),
      }),
      expect.objectContaining({ channelId: "telegram", sessionKey: "agent:test:session" }),
    );
  });

  it("runs reply_payload_sending hooks before inbound dispatcher delivery", async () => {
    const runReplyPayloadSending = vi.fn(async ({ payload }: { payload: { text?: string } }) => ({
      payload: {
        ...payload,
        text: `${payload.text ?? ""} + buttons`,
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Proceed", value: "action:proceed" }],
            },
          ],
        },
      },
    }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName?: string) => hookName === "reply_payload_sending"),
      runMessageSending: vi.fn(async () => undefined),
      runReplyPayloadSending,
    });
    hoisted.createReplyDispatcherMock.mockReturnValueOnce(createDispatcher([]));
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({ text: "ok" });

    await dispatchInboundMessageWithDispatcher({
      ctx: buildTestCtx({ Surface: "telegram", SessionKey: "agent:test:session" }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: {
        deliver: async () => undefined,
      },
      replyOptions: { runId: "run-123" },
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

    expect(payload).toMatchObject({
      text: "original reply + buttons",
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Proceed", value: "action:proceed" }],
          },
        ],
      },
    });
    const payloadWithMetadata = await dispatcherOptions.beforeDeliver(
      setReplyPayloadMetadata({ text: "original reply" }, { assistantMessageIndex: 4 }),
      { kind: "block" },
    );
    expect(payloadWithMetadata ? getReplyPayloadMetadata(payloadWithMetadata) : undefined).toEqual({
      assistantMessageIndex: 4,
      outboundHookLifecycle: {
        state: "prepared",
        preparedMediaCount: 0,
        runId: "run-123",
      },
    });
    expect(runReplyPayloadSending).toHaveBeenCalledWith(
      {
        payload: expect.objectContaining({ text: "original reply" }),
        kind: "final",
        channel: "telegram",
        sessionKey: "agent:test:session",
        runId: "run-123",
      },
      {
        channelId: "threads",
        accountId: "acct-1",
        conversationId: "conv-1",
        runId: "run-123",
      },
    );
  });

  it("preserves in-place modifier results as the accepted prepared payload", async () => {
    const runReplyPayloadSending = vi.fn(async ({ payload }: { payload: ReplyPayload }) => {
      payload.mediaUrls?.push("https://example.com/added.png");
      const firstBlock = payload.presentation?.blocks[0];
      if (firstBlock?.type === "buttons") {
        firstBlock.buttons[0]!.label = "Changed";
      }
      const telegram = payload.channelData?.telegram as { retries: number } | undefined;
      if (telegram) {
        telegram.retries = 2;
      }
    });
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName?: string) => hookName === "reply_payload_sending"),
      runReplyPayloadSending,
    });
    hoisted.createReplyDispatcherMock.mockReturnValueOnce(createDispatcher([]));
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({ text: "ok" });

    await dispatchInboundMessageWithDispatcher({
      ctx: buildTestCtx({ Surface: "telegram", SessionKey: "agent:test:session" }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: { deliver: async () => undefined },
    });

    const beforeDeliver = requireReplyDispatcherOptions().beforeDeliver;
    if (!beforeDeliver) {
      throw new Error("expected beforeDeliver hook");
    }
    const prepared = await beforeDeliver(
      {
        text: "original",
        mediaUrls: ["https://example.com/original.png"],
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Original", value: "original" }] }],
        },
        channelData: { telegram: { retries: 1 } },
      },
      { kind: "final" },
    );

    expect(prepared).not.toBeNull();
    expect(prepared).toMatchObject({
      mediaUrls: ["https://example.com/original.png", "https://example.com/added.png"],
      presentation: { blocks: [{ buttons: [{ label: "Changed" }] }] },
      channelData: { telegram: { retries: 2 } },
    });
    expect(getReplyPayloadMetadata(prepared!)?.outboundHookLifecycle?.state).toBe("prepared");
    expect(getReplyPayloadMetadata(prepared!)?.outboundHookLifecycle).toMatchObject({
      state: "prepared",
      preparedMediaCount: 2,
    });
  });

  it("correlates reply_payload_sending usageState with the generated run id", async () => {
    const usageState = { provider: "openai", model: "gpt-5.5" };
    const runReplyPayloadSending = vi.fn(async ({ payload }: { payload: { text?: string } }) => ({
      payload,
    }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName?: string) => hookName === "reply_payload_sending"),
      runMessageSending: vi.fn(async () => undefined),
      runReplyPayloadSending,
    });
    hoisted.createReplyDispatcherMock.mockReturnValueOnce(createDispatcher([]));
    hoisted.dispatchReplyFromConfigMock.mockImplementationOnce(async ({ replyOptions }) => {
      replyOptions?.onAgentRunStart?.("generated-run");
      recordReplyUsageState("generated-run", usageState);
      return { text: "ok" };
    });

    await dispatchInboundMessageWithDispatcher({
      ctx: buildTestCtx({ Surface: "telegram", SessionKey: "agent:test:session" }),
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

    await dispatcherOptions.beforeDeliver({ text: "original reply" }, { kind: "final" });

    expect(runReplyPayloadSending).toHaveBeenCalledWith(
      {
        payload: expect.objectContaining({ text: "original reply" }),
        kind: "final",
        channel: "telegram",
        sessionKey: "agent:test:session",
        runId: "generated-run",
        usageState,
      },
      {
        accountId: "acct-1",
        channelId: "threads",
        conversationId: "conv-1",
        runId: "generated-run",
      },
    );
  });

  it("runs message_sending after reply_payload_sending for inbound dispatcher delivery", async () => {
    const runReplyPayloadSending = vi.fn(async ({ payload }: { payload: { text?: string } }) => ({
      payload: {
        ...payload,
        text: `${payload.text ?? ""} + plugin`,
      },
    }));
    const runMessageSending = vi.fn(async () => ({ content: "sanitized plugin reply" }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn(
        (hookName?: string) =>
          hookName === "reply_payload_sending" || hookName === "message_sending",
      ),
      runMessageSending,
      runReplyPayloadSending,
    });
    hoisted.createReplyDispatcherMock.mockReturnValueOnce(createDispatcher([]));
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({ text: "ok" });

    await dispatchInboundMessageWithDispatcher({
      ctx: buildTestCtx({
        Surface: "telegram",
        SessionKey: "agent:test:session",
        OriginatingTo: "telegram:chat-1",
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

    expect(payload).toMatchObject({ text: "sanitized plugin reply" });
    expect(runReplyPayloadSending).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ text: "original reply" }),
      }),
      expect.anything(),
    );
    expect(runMessageSending).toHaveBeenCalledWith(
      expect.objectContaining({ content: "original reply + plugin", to: "telegram:chat-1" }),
      expect.objectContaining({ channelId: "telegram", conversationId: "telegram:chat-1" }),
    );
  });

  it("installs reply_payload_sending hooks on prebuilt dispatchers", async () => {
    const runReplyPayloadSending = vi.fn(async ({ payload }: { payload: { text?: string } }) => ({
      payload: {
        ...payload,
        text: `${payload.text ?? ""} + installed`,
      },
    }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName?: string) => hookName === "reply_payload_sending"),
      runMessageSending: vi.fn(async () => undefined),
      runReplyPayloadSending,
    });
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({ text: "ok" });
    const installedHooks: ReplyDispatchBeforeDeliver[] = [];
    const dispatcher = {
      ...createDispatcher([]),
      appendBeforeDeliver: vi.fn((hook: ReplyDispatchBeforeDeliver) => {
        installedHooks.push(hook);
      }),
    };

    await dispatchInboundMessage({
      ctx: buildTestCtx({ Surface: "discord", SessionKey: "agent:test:session" }),
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyOptions: { runId: "run-456" },
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(dispatcher.appendBeforeDeliver).toHaveBeenCalledTimes(1);
    const installedHook = installedHooks[0];
    if (!installedHook) {
      throw new Error("expected installed beforeDeliver hook");
    }
    const payload = await installedHook({ text: "prebuilt reply" }, { kind: "final" });

    expect(payload).toMatchObject({ text: "prebuilt reply + installed" });
    expect(runReplyPayloadSending).toHaveBeenCalledWith(
      {
        payload: expect.objectContaining({ text: "prebuilt reply" }),
        kind: "final",
        channel: "discord",
        sessionKey: "agent:test:session",
        runId: "run-456",
      },
      {
        accountId: "acct-1",
        channelId: "threads",
        conversationId: "conv-1",
        runId: "run-456",
      },
    );
  });

  it("installs reply_payload_sending hooks before lazy plugin availability is known", async () => {
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn(() => false),
      runMessageSending: vi.fn(async () => undefined),
      runReplyPayloadSending: vi.fn(async () => undefined),
    });
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({ text: "ok" });
    const dispatcher = {
      ...createDispatcher([]),
      appendBeforeDeliver: vi.fn(),
    };

    await dispatchInboundMessage({
      ctx: buildTestCtx({ Surface: "discord", SessionKey: "agent:test:session" }),
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyOptions: { runId: "run-789" },
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(dispatcher.appendBeforeDeliver).toHaveBeenCalledTimes(1);
  });

  it("emits message_sent after a prebuilt dispatcher completes native delivery", async () => {
    const runMessageSent = vi.fn(async () => undefined);
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName?: string) => hookName === "message_sent"),
      runMessageSending: vi.fn(async () => undefined),
      runReplyPayloadSending: vi.fn(async () => undefined),
      runMessageSent,
    });
    let afterDeliver: Parameters<NonNullable<ReplyDispatcher["appendAfterDeliver"]>>[0] | undefined;
    const dispatcher = {
      ...createDispatcher([]),
      appendBeforeDeliver: vi.fn(),
      appendAfterDeliver: vi.fn((hook) => {
        afterDeliver = hook;
      }),
    };
    hoisted.dispatchReplyFromConfigMock.mockImplementationOnce(async () => {
      await afterDeliver?.(
        { text: "delivered text", spokenText: "speech-only rendering" },
        { kind: "final" },
        {
          status: "delivered",
          result: { messageId: "message-1", content: "provider-finalized text" },
        },
      );
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });

    await dispatchInboundMessage({
      ctx: buildTestCtx({ Surface: "feishu", SessionKey: "agent:test:session" }),
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyOptions: { runId: "run-sent" },
    });

    expect(runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "provider-finalized text",
        messageId: "message-1",
        runId: "run-sent",
        success: true,
      }),
      expect.objectContaining({
        channelId: "feishu",
        conversationId: "conv-1",
      }),
    );
  });

  it("emits message_sent success when bookkeeping fails after native delivery", async () => {
    const runMessageSent = vi.fn(async () => undefined);
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName?: string) => hookName === "message_sent"),
      runMessageSending: vi.fn(async () => undefined),
      runReplyPayloadSending: vi.fn(async () => undefined),
      runMessageSent,
    });
    let afterDeliver: Parameters<NonNullable<ReplyDispatcher["appendAfterDeliver"]>>[0] | undefined;
    const dispatcher = {
      ...createDispatcher([]),
      appendBeforeDeliver: vi.fn(),
      appendAfterDeliver: vi.fn((hook) => {
        afterDeliver = hook;
      }),
    };
    hoisted.dispatchReplyFromConfigMock.mockImplementationOnce(async () => {
      const error = markSuccessfulNativeDelivery(new Error("queue ack failed"), "message-1");
      await afterDeliver?.(
        { text: "delivered text" },
        { kind: "final" },
        { status: "failed", error },
      );
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });

    await dispatchInboundMessage({
      ctx: buildTestCtx({ Surface: "feishu", SessionKey: "agent:test:session" }),
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyOptions: { runId: "run-sent" },
    });

    expect(runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "delivered text",
        messageId: "message-1",
        runId: "run-sent",
        success: true,
      }),
      expect.anything(),
    );
  });

  it("keeps message_sent attributed to the run captured by the payload", async () => {
    const runMessageSent = vi.fn(async () => undefined);
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName?: string) => hookName === "message_sent"),
      runMessageSending: vi.fn(async () => undefined),
      runReplyPayloadSending: vi.fn(async () => undefined),
      runMessageSent,
    });
    let beforeDeliver: ReplyDispatchBeforeDeliver | undefined;
    let afterDeliver: Parameters<NonNullable<ReplyDispatcher["appendAfterDeliver"]>>[0] | undefined;
    const runState = { runId: "run-one" };
    const dispatcher = {
      ...createDispatcher([]),
      appendBeforeDeliver: vi.fn((hook: ReplyDispatchBeforeDeliver) => {
        beforeDeliver = hook;
      }),
      appendAfterDeliver: vi.fn((hook) => {
        afterDeliver = hook;
      }),
    };
    hoisted.dispatchReplyFromConfigMock.mockImplementationOnce(async () => {
      const preparedPayload = await beforeDeliver?.({ text: "first run" }, { kind: "final" });
      if (!preparedPayload) {
        throw new Error("expected prepared payload");
      }
      runState.runId = "run-two";
      await afterDeliver?.(
        preparedPayload,
        { kind: "final" },
        {
          status: "delivered",
          result: { messageId: "message-1" },
        },
      );
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });

    await dispatchInboundMessage({
      ctx: buildTestCtx({ Surface: "feishu", SessionKey: "agent:test:session" }),
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyPayloadRunState: runState,
    });

    expect(runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-one", success: true }),
      expect.anything(),
    );
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
