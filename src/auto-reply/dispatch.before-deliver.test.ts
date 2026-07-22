/** Tests configured beforeDeliver composition with the canonical outbound hook lifecycle. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "./reply-payload.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.types.js";
import { buildTestCtx } from "./reply/test-ctx.js";

type DispatchReplyFromConfigFn =
  typeof import("./reply/dispatch-from-config.js").dispatchReplyFromConfig;
type FinalizeInboundContextFn = typeof import("./reply/inbound-context.js").finalizeInboundContext;
type DeriveInboundMessageHookContextFn =
  typeof import("../hooks/message-hook-mappers.js").deriveInboundMessageHookContext;
type GetGlobalHookRunnerFn = typeof import("../plugins/hook-runner-global.js").getGlobalHookRunner;
type CreateReplyDispatcherFn = typeof import("./reply/reply-dispatcher.js").createReplyDispatcher;

const hoisted = vi.hoisted(() => ({
  dispatchReplyFromConfigMock: vi.fn(),
  finalizeInboundContextMock: vi.fn((ctx: unknown, _opts?: unknown) => ctx),
  deriveInboundMessageHookContextMock: vi.fn(),
  getGlobalHookRunnerMock: vi.fn(),
  createReplyDispatcherMock: vi.fn(),
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
  };
});

const { dispatchInboundMessageWithDispatcher } = await import("./dispatch.js");

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: () => true,
    sendBlockReply: () => true,
    sendFinalReply: () => true,
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => undefined,
    waitForIdle: async () => undefined,
  };
}

describe("dispatch beforeDeliver composition", () => {
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
  });

  it("runs outbound modifiers before a custom beforeDeliver stage", async () => {
    const customBeforeDeliver = vi.fn(async (payload: { text?: string }) => ({
      text: `${payload.text ?? ""} [custom]`,
    }));
    const runMessageSending = vi.fn(async () => ({ content: "message hook" }));
    const runReplyPayloadSending = vi.fn(async ({ payload }: { payload: { text?: string } }) => ({
      payload: { ...payload, text: `${payload.text ?? ""} [plugin]` },
    }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn(
        (hookName?: string) =>
          hookName === "message_sending" || hookName === "reply_payload_sending",
      ),
      runMessageSending,
      runReplyPayloadSending,
    });
    hoisted.createReplyDispatcherMock.mockReturnValueOnce(createDispatcher());
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({ text: "ok" });

    await dispatchInboundMessageWithDispatcher({
      ctx: buildTestCtx({ Surface: "telegram", SessionKey: "agent:test:session" }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: {
        deliver: async () => undefined,
        beforeDeliver: customBeforeDeliver,
      },
      replyResolver: async () => ({ text: "ok" }),
    });

    const dispatcherOptions = hoisted.createReplyDispatcherMock.mock.calls[0]?.[0] as
      | Parameters<CreateReplyDispatcherFn>[0]
      | undefined;
    if (!dispatcherOptions?.beforeDeliver) {
      throw new Error("expected beforeDeliver hook");
    }

    const payload = await dispatcherOptions.beforeDeliver({ text: "original" }, { kind: "final" });
    const payloadWithMetadata = await dispatcherOptions.beforeDeliver(
      setReplyPayloadMetadata({ text: "original" }, { assistantMessageIndex: 5 }),
      { kind: "block" },
    );

    expect(customBeforeDeliver).toHaveBeenCalledTimes(2);
    expect(customBeforeDeliver).toHaveBeenCalledWith(
      expect.objectContaining({ text: "message hook" }),
      { kind: "final" },
    );
    expect(runMessageSending).toHaveBeenCalledTimes(2);
    expect(runMessageSending).toHaveBeenCalledWith(
      expect.objectContaining({ content: "original [plugin]", to: "conv-1" }),
      expect.objectContaining({
        accountId: "acct-1",
        channelId: "telegram",
        conversationId: "conv-1",
      }),
    );
    expect(runReplyPayloadSending).toHaveBeenCalledTimes(2);
    expect(runReplyPayloadSending).toHaveBeenCalledWith(
      {
        payload: expect.objectContaining({ text: "original" }),
        kind: "final",
        channel: "telegram",
        sessionKey: "agent:test:session",
        runId: undefined,
      },
      {
        accountId: "acct-1",
        channelId: "threads",
        conversationId: "conv-1",
        runId: undefined,
      },
    );
    expect(payload).toMatchObject({ text: "message hook [custom]" });
    expect(payloadWithMetadata ? getReplyPayloadMetadata(payloadWithMetadata) : undefined).toEqual({
      assistantMessageIndex: 5,
      outboundHookLifecycle: {
        state: "prepared",
      },
    });
  });

  it("suppresses delivery when reply_payload_sending empties the payload", async () => {
    const runReplyPayloadSending = vi.fn(async ({ payload }: { payload: { text?: string } }) => ({
      payload: { ...payload, text: "" },
    }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName?: string) => hookName === "reply_payload_sending"),
      runMessageSending: vi.fn(async () => undefined),
      runReplyPayloadSending,
    });
    hoisted.createReplyDispatcherMock.mockReturnValueOnce(createDispatcher());
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({ text: "ok" });

    await dispatchInboundMessageWithDispatcher({
      ctx: buildTestCtx({ Surface: "telegram", SessionKey: "agent:test:session" }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: { deliver: async () => undefined },
      replyResolver: async () => ({ text: "ok" }),
    });

    const beforeDeliver = (
      hoisted.createReplyDispatcherMock.mock.calls[0]?.[0] as
        | Parameters<CreateReplyDispatcherFn>[0]
        | undefined
    )?.beforeDeliver;
    if (!beforeDeliver) {
      throw new Error("expected beforeDeliver hook");
    }
    expect(await beforeDeliver({ text: "original reply" }, { kind: "final" })).toBeNull();
  });

  it("keeps media when message_sending removes its caption", async () => {
    const runMessageSending = vi.fn(async () => ({ content: "" }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName?: string) => hookName === "message_sending"),
      runMessageSending,
      runReplyPayloadSending: vi.fn(async () => undefined),
    });
    hoisted.createReplyDispatcherMock.mockReturnValueOnce(createDispatcher());
    hoisted.dispatchReplyFromConfigMock.mockResolvedValueOnce({ text: "ok" });

    await dispatchInboundMessageWithDispatcher({
      ctx: buildTestCtx({ Surface: "telegram", SessionKey: "agent:test:session" }),
      cfg: {} as OpenClawConfig,
      dispatcherOptions: { deliver: async () => undefined },
    });

    const beforeDeliver = (
      hoisted.createReplyDispatcherMock.mock.calls[0]?.[0] as
        | Parameters<CreateReplyDispatcherFn>[0]
        | undefined
    )?.beforeDeliver;
    if (!beforeDeliver) {
      throw new Error("expected beforeDeliver hook");
    }

    expect(await beforeDeliver({ text: "remove me" }, { kind: "final" })).toBeNull();
    expect(
      await beforeDeliver(
        { text: "remove caption", mediaUrl: "https://example.com/keep.png" },
        { kind: "final" },
      ),
    ).toMatchObject({ text: "", mediaUrl: "https://example.com/keep.png" });
  });
});
