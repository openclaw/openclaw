import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import { registerReplyDispatcherSettledTask, withReplyDispatcher } from "./dispatch-dispatcher.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "./reply-payload.js";
import type { ReplyDispatchBeforeDeliver } from "./reply/reply-dispatcher.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.types.js";
import { buildTestCtx } from "./reply/test-ctx.js";

type CreateReplyDispatcherFn = typeof import("./reply/reply-dispatcher.js").createReplyDispatcher;
type TestContext = Parameters<typeof buildTestCtx>[0];
type DispatcherOptions = Parameters<CreateReplyDispatcherFn>[0];

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  deriveContext: vi.fn(),
  hooks: vi.fn(),
  createDispatcher: vi.fn(),
  createTypingDispatcher: vi.fn(),
}));

vi.mock("./reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: mocks.dispatch,
}));

vi.mock("./reply/inbound-context.js", () => ({
  finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
}));

vi.mock("../hooks/message-hook-mappers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/message-hook-mappers.js")>()),
  deriveInboundMessageHookContext: mocks.deriveContext,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: mocks.hooks,
}));

vi.mock("./reply/reply-dispatcher.js", async () => {
  const actual = await vi.importActual<typeof import("./reply/reply-dispatcher.js")>(
    "./reply/reply-dispatcher.js",
  );
  return {
    ...actual,
    createReplyDispatcher: mocks.createDispatcher,
    createReplyDispatcherWithTyping: mocks.createTypingDispatcher,
  };
});

const {
  dispatchInboundMessage,
  dispatchInboundMessageWithDispatcher,
  dispatchInboundMessageWithBufferedDispatcher,
  dispatchInboundMessageWithProjectedDispatcher,
} = await import("./dispatch.js");
const { recordReplyUsageState } = await import("./reply/reply-usage-state.js");

function createDispatcher(record: string[]): ReplyDispatcher {
  return {
    sendToolResult: () => true,
    sendBlockReply: () => true,
    sendFinalReply: () => true,
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => void record.push("markComplete"),
    waitForIdle: async () => void record.push("waitForIdle"),
  };
}

function installBufferedDispatcher(replyOptions = {}) {
  mocks.createTypingDispatcher.mockReturnValueOnce({
    dispatcher: createDispatcher([]),
    replyOptions,
    markDispatchIdle: vi.fn(),
    markRunComplete: vi.fn(),
  });
  mocks.dispatch.mockResolvedValueOnce({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  });
}

function installHooks(
  runReplyPayloadSending: unknown = vi.fn(async () => undefined),
  runMessageSending: unknown = vi.fn(async () => undefined),
  mode: "none" | "payload" | "both" | "all" = "payload",
) {
  mocks.hooks.mockReturnValue({
    hasHooks: vi.fn(
      (name?: string) =>
        mode === "all" ||
        (mode !== "none" && name === "reply_payload_sending") ||
        (mode === "both" && name === "message_sending"),
    ),
    runMessageSending,
    runReplyPayloadSending,
  });
}

function dispatchParams(
  ctx: TestContext = {},
  dispatcherOptions: DispatcherOptions = { deliver: async () => undefined },
) {
  return { ctx: buildTestCtx(ctx), cfg: {}, dispatcherOptions };
}

function replyParams(surface: string, options?: DispatcherOptions) {
  return {
    ...dispatchParams({ Surface: surface, SessionKey: "agent:test:session" }, options),
    replyResolver: async () => ({ text: "ok" }),
  };
}

function requireBeforeDeliver(): ReplyDispatchBeforeDeliver {
  const call = expectDefined(mocks.createDispatcher.mock.calls[0], "dispatcher creation");
  const options: DispatcherOptions = call[0];
  return expectDefined(options.beforeDeliver, "beforeDeliver hook");
}

function expectReplyHookCall(
  hook: unknown,
  text: string,
  channel: string,
  runId?: string,
  extra: Record<string, unknown> = {},
) {
  expect(hook).toHaveBeenCalledWith(
    {
      payload: { text },
      kind: "final",
      channel,
      sessionKey: "agent:test:session",
      runId,
      ...extra,
    },
    { accountId: "acct-1", channelId: "threads", conversationId: "conv-1", runId },
  );
}

async function installProjectedBeforeDeliver(
  overrides: Partial<Parameters<typeof dispatchInboundMessageWithProjectedDispatcher>[0]> = {},
): Promise<ReplyDispatchBeforeDeliver> {
  mocks.createDispatcher.mockReturnValueOnce(createDispatcher([]));
  mocks.dispatch.mockResolvedValueOnce({ text: "ok" });
  await dispatchInboundMessageWithProjectedDispatcher({
    ...dispatchParams({ Surface: "webchat", SessionKey: "agent:test:main" }),
    ...overrides,
  });
  return requireBeforeDeliver();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deriveContext.mockReturnValue({
    channelId: "threads",
    accountId: "acct-1",
    conversationId: "conv-1",
    isGroup: false,
    to: "thread:1",
  });
  installHooks(undefined, undefined, "none");
});

it("dispatchInboundMessage owns dispatcher lifecycle", async () => {
  const order: string[] = [];
  const dispatcher = {
    ...createDispatcher(order),
    sendFinalReply: () => {
      order.push("sendFinalReply");
      return true;
    },
  } satisfies ReplyDispatcher;
  mocks.dispatch.mockImplementationOnce(async ({ dispatcher: dispatcherLocal }) => {
    dispatcherLocal.sendFinalReply({ text: "ok" });
    return { text: "ok" };
  });
  await dispatchInboundMessage({
    ctx: buildTestCtx(),
    cfg: {},
    dispatcher,
    onSettled: () => void order.push("onSettled"),
    replyResolver: async () => ({ text: "ok" }),
  });
  expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle", "onSettled"]);
});

it.each(["run", "waitForIdle"])(
  "runs every cleanup and preserves the original %s failure",
  async (failedStage) => {
    const order: string[] = [];
    const failure = new Error(`${failedStage} failed`);
    const laterFailure = new Error("later cleanup failed");
    const visit = (stage: string) => {
      order.push(stage);
      if (stage === failedStage) {
        throw failure;
      }
    };
    const dispatcher = createDispatcher(order);
    dispatcher.waitForIdle = async () => visit("waitForIdle");
    registerReplyDispatcherSettledTask(dispatcher, () => visit("settledTask"));
    registerReplyDispatcherSettledTask(dispatcher, () => {
      order.push("laterTask");
      throw laterFailure;
    });
    registerReplyDispatcherSettledTask(dispatcher, () => void order.push("lastTask"));

    await expect(
      withReplyDispatcher({
        dispatcher,
        run: async () => visit("run"),
        onSettled: () => {
          order.push("onSettled");
          throw laterFailure;
        },
      }),
    ).rejects.toBe(failure);

    expect(order).toEqual([
      "run",
      "markComplete",
      "waitForIdle",
      "settledTask",
      "laterTask",
      "lastTask",
      "onSettled",
    ]);
    dispatcher.waitForIdle = async () => undefined;
    await withReplyDispatcher({ dispatcher, run: async () => undefined });
    expect(order.filter((stage) => stage === "settledTask")).toHaveLength(1);
  },
);

it("composes channel and dispatcher typing-controller observers", async () => {
  const dispatcherObserver = vi.fn();
  const channelObserver = vi.fn();
  installBufferedDispatcher({ onTypingController: dispatcherObserver });
  await dispatchInboundMessageWithBufferedDispatcher({
    ...dispatchParams(),
    replyOptions: { onTypingController: channelObserver },
  });
  const typingController = {} as never;
  const resolvedParams = mocks.dispatch.mock.calls[0]?.[0];
  resolvedParams?.replyOptions?.onTypingController?.(typingController);
  expect(dispatcherObserver).toHaveBeenCalledWith(typingController);
  expect(channelObserver).toHaveBeenCalledWith(typingController);
});

it("passes runtime toolsAllow from buffered dispatch into reply resolution", async () => {
  installBufferedDispatcher();
  await dispatchInboundMessageWithBufferedDispatcher({
    ...dispatchParams(),
    toolsAllow: ["message"],
  });
  const params = mocks.dispatch.mock.calls[0]?.[0];
  expect(params?.replyOptions?.toolsAllow).toEqual(["message"]);
});

it("correlates reply_payload_sending usageState with the generated run id", async () => {
  const usageState = { provider: "openai", model: "gpt-5.5" };
  const runReplyPayloadSending = vi.fn(async ({ payload }: { payload: { text?: string } }) => ({
    payload,
  }));
  installHooks(runReplyPayloadSending);
  mocks.createDispatcher.mockReturnValueOnce(createDispatcher([]));
  mocks.dispatch.mockImplementationOnce(async ({ replyOptions }) => {
    replyOptions?.onAgentRunStart?.("generated-run");
    recordReplyUsageState("generated-run", usageState);
    return { text: "ok" };
  });
  await dispatchInboundMessageWithDispatcher(replyParams("telegram"));
  await requireBeforeDeliver()({ text: "original reply" }, { kind: "final" });
  expectReplyHookCall(runReplyPayloadSending, "original reply", "telegram", "generated-run", {
    usageState,
  });
});

it("runs media-aware projected modifiers once in order", async () => {
  const order: string[] = [];
  const runReplyPayloadSending = vi.fn(async ({ payload }: { payload: { text?: string } }) => {
    order.push("reply_payload_sending");
    return { payload: { ...payload, text: "reply rewrite", mediaUrls: ["media://reply.png"] } };
  });
  const runMessageSending = vi.fn(async () => {
    order.push("message_sending");
    return { content: "message rewrite" };
  });
  mocks.deriveContext.mockReturnValue({
    channelId: "webchat",
    accountId: "acct-web",
    conversationId: "main",
    isGroup: false,
    from: "main",
  });
  installHooks(runReplyPayloadSending, runMessageSending, "both");
  const onSessionMetadataChanges = vi.fn();
  const beforeDeliver = await installProjectedBeforeDeliver({
    ...dispatchParams({
      Surface: "webchat",
      SessionKey: "agent:test:main",
      OriginatingTo: "main",
    }),
    onSessionMetadataChanges,
    replyOptions: { runId: "run-web" },
    replyResolver: async () => ({ text: "ok" }),
  });
  const payload = await beforeDeliver(
    setReplyPayloadMetadata({ text: "original" }, { assistantMessageIndex: 7 }),
    { kind: "final" },
  );
  expect(order).toEqual(["reply_payload_sending", "message_sending"]);
  expect(runReplyPayloadSending).toHaveBeenCalledOnce();
  expect(runMessageSending).toHaveBeenCalledOnce();
  expect(runMessageSending).toHaveBeenCalledWith(
    {
      to: "main",
      content: "reply rewrite",
      replyToId: undefined,
      threadId: undefined,
      metadata: { channel: "webchat", accountId: "acct-web", mediaUrls: ["media://reply.png"] },
    },
    {
      channelId: "webchat",
      accountId: "acct-web",
      conversationId: "main",
      sessionKey: "agent:test:main",
    },
  );
  expect(payload).toEqual({ text: "message rewrite", mediaUrls: ["media://reply.png"] });
  expect(payload ? getReplyPayloadMetadata(payload) : undefined).toMatchObject({
    assistantMessageIndex: 7,
  });
  expect(mocks.dispatch.mock.calls[0]?.[0]?.onSessionMetadataChanges).toBe(
    onSessionMetadataChanges,
  );
});

it("stops projected delivery before message hooks when reply hooks cancel", async () => {
  const runMessageSending = vi.fn(async () => ({ content: "unreachable" }));
  installHooks(
    vi.fn(async () => ({ cancel: true })),
    runMessageSending,
    "all",
  );
  const beforeDeliver = await installProjectedBeforeDeliver();
  await expect(beforeDeliver({ text: "original" }, { kind: "final" })).resolves.toBeNull();
  expect(runMessageSending).not.toHaveBeenCalled();
});

it("installs reply_payload_sending hooks on prebuilt dispatchers", async () => {
  const runReplyPayloadSending = vi.fn(async ({ payload }: { payload: { text?: string } }) => ({
    payload: {
      ...payload,
      text: `${payload.text ?? ""} + installed`,
    },
  }));
  installHooks(runReplyPayloadSending);
  mocks.dispatch.mockResolvedValueOnce({ text: "ok" });
  const installedHooks: ReplyDispatchBeforeDeliver[] = [];
  const dispatcher = {
    ...createDispatcher([]),
    appendBeforeDeliver: vi.fn((hook: ReplyDispatchBeforeDeliver) => {
      installedHooks.push(hook);
    }),
  };

  await dispatchInboundMessage({
    ...replyParams("discord"),
    dispatcher,
    replyOptions: { runId: "run-456" },
  });

  expect(dispatcher.appendBeforeDeliver).toHaveBeenCalledTimes(1);
  const installedHook = installedHooks[0];
  if (!installedHook) {
    throw new Error("expected installed beforeDeliver hook");
  }
  const payload = await installedHook({ text: "prebuilt reply" }, { kind: "final" });

  expect(payload).toEqual({ text: "prebuilt reply + installed" });
  expectReplyHookCall(runReplyPayloadSending, "prebuilt reply", "discord", "run-456");
});

it("composes custom beforeDeliver with reply_payload_sending hooks", async () => {
  const customBeforeDeliver = vi.fn(async (payload: { text?: string }) => ({
    text: `${payload.text ?? ""} [custom]`,
  }));
  const runMessageSending = vi.fn(async () => ({ content: "message hook" }));
  const runReplyPayloadSending = vi.fn(async ({ payload }: { payload: { text?: string } }) => ({
    payload: {
      ...payload,
      text: `${payload.text ?? ""} [plugin]`,
    },
  }));
  installHooks(runReplyPayloadSending, runMessageSending, "both");
  mocks.createDispatcher.mockReturnValueOnce(createDispatcher([]));
  mocks.dispatch.mockResolvedValueOnce({ text: "ok" });

  await dispatchInboundMessageWithDispatcher(
    replyParams("telegram", {
      deliver: async () => undefined,
      beforeDeliver: customBeforeDeliver,
    }),
  );
  const beforeDeliver = requireBeforeDeliver();
  const payload = await beforeDeliver({ text: "original" }, { kind: "final" });
  const payloadWithMetadata = await beforeDeliver(
    setReplyPayloadMetadata({ text: "original" }, { assistantMessageIndex: 5 }),
    { kind: "block" },
  );

  expect(customBeforeDeliver).toHaveBeenCalledTimes(2);
  expect(customBeforeDeliver).toHaveBeenCalledWith({ text: "original" }, { kind: "final" });
  expect(runMessageSending).not.toHaveBeenCalled();
  expect(runReplyPayloadSending).toHaveBeenCalledTimes(2);
  expectReplyHookCall(runReplyPayloadSending, "original [custom]", "telegram");
  expect(payload).toEqual({ text: "original [custom] [plugin]" });
  expect(payloadWithMetadata ? getReplyPayloadMetadata(payloadWithMetadata) : undefined).toEqual({
    assistantMessageIndex: 5,
  });
});
