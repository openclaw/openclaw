import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EMOJIS } from "../../channels/status-reactions.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";
import {
  __testing as threadBindingTesting,
  createThreadBindingManager,
} from "./thread-bindings.js";

const sendMocks = vi.hoisted(() => ({
  reactMessageDiscord: vi.fn(async () => {}),
  removeReactionDiscord: vi.fn(async () => {}),
}));
function createMockDraftStream() {
  return {
    update: vi.fn<(text: string) => void>(() => {}),
    flush: vi.fn(async () => {}),
    messageId: vi.fn(() => "preview-1"),
    clear: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    forceNewMessage: vi.fn(() => {}),
  };
}

const deliveryMocks = vi.hoisted(() => ({
  editMessageDiscord: vi.fn(async () => ({})),
  deliverDiscordReply: vi.fn(async () => {}),
  createDiscordDraftStream: vi.fn(() => createMockDraftStream()),
}));
const editMessageDiscord = deliveryMocks.editMessageDiscord;
const deliverDiscordReply = deliveryMocks.deliverDiscordReply;
const createDiscordDraftStream = deliveryMocks.createDiscordDraftStream;
type DispatchInboundParams = {
  dispatcher: {
    sendBlockReply: (payload: {
      text?: string;
      isReasoning?: boolean;
    }) => boolean | Promise<boolean>;
    sendFinalReply: (payload: {
      text?: string;
      isReasoning?: boolean;
    }) => boolean | Promise<boolean>;
  };
  replyOptions?: {
    onReasoningStream?: () => Promise<void> | void;
    onReasoningEnd?: () => Promise<void> | void;
    onToolStart?: (payload: { name?: string }) => Promise<void> | void;
    onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
    onAssistantMessageStart?: () => Promise<void> | void;
  };
};
const dispatchInboundMessage = vi.fn(async (_params?: DispatchInboundParams) => ({
  queuedFinal: false,
  counts: { final: 0, tool: 0, block: 0 },
}));
const recordInboundSession = vi.fn(async () => {});
const configSessionsMocks = vi.hoisted(() => ({
  readSessionUpdatedAt: vi.fn(() => undefined),
  resolveStorePath: vi.fn(() => "/tmp/openclaw-discord-process-test-sessions.json"),
}));
const readSessionUpdatedAt = configSessionsMocks.readSessionUpdatedAt;
const resolveStorePath = configSessionsMocks.resolveStorePath;

vi.mock("../send.js", () => ({
  reactMessageDiscord: sendMocks.reactMessageDiscord,
  removeReactionDiscord: sendMocks.removeReactionDiscord,
}));

vi.mock("../send.messages.js", () => ({
  editMessageDiscord: deliveryMocks.editMessageDiscord,
}));

vi.mock("../draft-stream.js", () => ({
  createDiscordDraftStream: deliveryMocks.createDiscordDraftStream,
}));

vi.mock("./reply-delivery.js", () => ({
  deliverDiscordReply: deliveryMocks.deliverDiscordReply,
}));

vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage,
}));

vi.mock("../../auto-reply/reply/reply-dispatcher.js", () => ({
  createReplyDispatcherWithTyping: vi.fn(
    (opts: { deliver: (payload: unknown, info: { kind: string }) => Promise<void> | void }) => ({
      dispatcher: {
        sendToolResult: vi.fn(() => true),
        sendBlockReply: vi.fn((payload: unknown) => {
          void opts.deliver(payload as never, { kind: "block" });
          return true;
        }),
        sendFinalReply: vi.fn((payload: unknown) => {
          void opts.deliver(payload as never, { kind: "final" });
          return true;
        }),
        waitForIdle: vi.fn(async () => {}),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        markComplete: vi.fn(),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    }),
  ),
}));

vi.mock("../../channels/session.js", () => ({
  recordInboundSession,
}));

vi.mock("../../config/sessions.js", () => ({
  readSessionUpdatedAt: configSessionsMocks.readSessionUpdatedAt,
  resolveStorePath: configSessionsMocks.resolveStorePath,
}));

const { processDiscordMessage } = await import("./message-handler.process.js");

const createBaseContext = createBaseDiscordMessageContext;

beforeEach(() => {
  vi.useRealTimers();
  sendMocks.reactMessageDiscord.mockClear();
  sendMocks.removeReactionDiscord.mockClear();
  editMessageDiscord.mockClear();
  deliverDiscordReply.mockClear();
  createDiscordDraftStream.mockClear();
  dispatchInboundMessage.mockClear();
  recordInboundSession.mockClear();
  readSessionUpdatedAt.mockClear();
  resolveStorePath.mockClear();
  dispatchInboundMessage.mockResolvedValue({
    queuedFinal: false,
    counts: { final: 0, tool: 0, block: 0 },
  });
  recordInboundSession.mockResolvedValue(undefined);
  readSessionUpdatedAt.mockReturnValue(undefined);
  resolveStorePath.mockReturnValue("/tmp/openclaw-discord-process-test-sessions.json");
  threadBindingTesting.resetThreadBindingsForTests();
});

function getLastRouteUpdate():
  | { sessionKey?: string; channel?: string; to?: string; accountId?: string }
  | undefined {
  const callArgs = recordInboundSession.mock.calls.at(-1) as unknown[] | undefined;
  const params = callArgs?.[0] as
    | {
        updateLastRoute?: {
          sessionKey?: string;
          channel?: string;
          to?: string;
          accountId?: string;
        };
      }
    | undefined;
  return params?.updateLastRoute;
}

function getLastDispatchCtx():
  | { SessionKey?: string; MessageThreadId?: string | number }
  | undefined {
  const callArgs = dispatchInboundMessage.mock.calls.at(-1) as unknown[] | undefined;
  const params = callArgs?.[0] as
    | { ctx?: { SessionKey?: string; MessageThreadId?: string | number } }
    | undefined;
  return params?.ctx;
}

describe("processDiscordMessage ack reactions", () => {
  it("skips ack reactions for group-mentions when mentions are not required", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(sendMocks.reactMessageDiscord).not.toHaveBeenCalled();
  });

  it("sends ack reactions for mention-gated guild messages when mentioned", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: true,
      effectiveWasMentioned: true,
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(sendMocks.reactMessageDiscord.mock.calls[0]).toEqual(["c1", "m1", "👀", { rest: {} }]);
  });

  it("uses preflight-resolved messageChannelId when message.channelId is missing", async () => {
    const ctx = await createBaseContext({
      message: {
        id: "m1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageChannelId: "fallback-channel",
      shouldRequireMention: true,
      effectiveWasMentioned: true,
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(sendMocks.reactMessageDiscord.mock.calls[0]).toEqual([
      "fallback-channel",
      "m1",
      "👀",
      { rest: {} },
    ]);
  });

  it("debounces intermediate phase reactions and jumps to done for short runs", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await params?.replyOptions?.onToolStart?.({ name: "exec" });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext();

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    const emojis = (
      sendMocks.reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toContain("👀");
    expect(emojis).toContain(DEFAULT_EMOJIS.done);
    expect(emojis).not.toContain(DEFAULT_EMOJIS.thinking);
    expect(emojis).not.toContain(DEFAULT_EMOJIS.coding);
  });

  it("shows stall emojis for long no-progress runs", async () => {
    vi.useFakeTimers();
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = () => resolve();
    });
    dispatchInboundMessage.mockImplementationOnce(async () => {
      await dispatchGate;
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext();
    // oxlint-disable-next-line typescript/no-explicit-any
    const runPromise = processDiscordMessage(ctx as any);

    await vi.advanceTimersByTimeAsync(30_001);
    releaseDispatch();
    await vi.runAllTimersAsync();

    await runPromise;
    const emojis = (
      sendMocks.reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toContain(DEFAULT_EMOJIS.stallSoft);
    expect(emojis).toContain(DEFAULT_EMOJIS.stallHard);
    expect(emojis).toContain(DEFAULT_EMOJIS.done);
  });

  it("applies status reaction emoji/timing overrides from config", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: {
          ackReaction: "👀",
          statusReactions: {
            emojis: { queued: "🟦", thinking: "🧪", done: "🏁" },
            timing: { debounceMs: 0 },
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    const emojis = (
      sendMocks.reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toContain("🟦");
    expect(emojis).toContain("🏁");
  });
});

describe("processDiscordMessage session routing", () => {
  it("stores DM lastRoute with user target for direct-session continuity", async () => {
    const ctx = await createBaseContext({
      data: { guild: null },
      channelInfo: null,
      channelName: undefined,
      isGuildMessage: false,
      isDirectMessage: true,
      isGroupDm: false,
      shouldRequireMention: false,
      canDetectMention: false,
      effectiveWasMentioned: false,
      displayChannelSlug: "",
      guildInfo: null,
      guildSlug: "",
      message: {
        id: "m1",
        channelId: "dm1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageChannelId: "dm1",
      baseSessionKey: "agent:main:discord:direct:u1",
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:discord:direct:u1",
        mainSessionKey: "agent:main:main",
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:discord:direct:u1",
      channel: "discord",
      to: "user:U1",
      accountId: "default",
    });
  });

  it("stores group lastRoute with channel target", async () => {
    const ctx = await createBaseContext({
      baseSessionKey: "agent:main:discord:channel:c1",
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:discord:channel:c1",
        mainSessionKey: "agent:main:main",
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:discord:channel:c1",
      channel: "discord",
      to: "channel:c1",
      accountId: "default",
    });
  });

  it("prefers bound session keys and sets MessageThreadId for bound thread messages", async () => {
    const threadBindings = createThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    await threadBindings.bindTarget({
      threadId: "thread-1",
      channelId: "c-parent",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      agentId: "main",
      webhookId: "wh_1",
      webhookToken: "tok_1",
      introText: "",
    });

    const ctx = await createBaseContext({
      messageChannelId: "thread-1",
      threadChannel: { id: "thread-1", name: "subagent-thread" },
      boundSessionKey: "agent:main:subagent:child",
      threadBindings,
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:discord:channel:c1",
        mainSessionKey: "agent:main:main",
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(getLastDispatchCtx()).toMatchObject({
      SessionKey: "agent:main:subagent:child",
      MessageThreadId: "thread-1",
    });
    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:subagent:child",
      channel: "discord",
      to: "channel:thread-1",
      accountId: "default",
    });
  });
});

describe("processDiscordMessage draft streaming", () => {
  async function runSingleChunkFinalScenario(discordConfig: Record<string, unknown>) {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "Hello\nWorld" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      discordConfig,
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);
  }

  async function createBlockModeContext() {
    return await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀" },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
        channels: {
          discord: {
            draftChunk: { minChars: 1, maxChars: 5, breakPreference: "newline" },
          },
        },
      },
      discordConfig: { streamMode: "block" },
    });
  }

  it("finalizes via preview edit when final fits one chunk", async () => {
    await runSingleChunkFinalScenario({ streamMode: "partial", maxLinesPerMessage: 5 });

    expect(editMessageDiscord).toHaveBeenCalledWith(
      "c1",
      "preview-1",
      { content: "Hello\nWorld" },
      { rest: {} },
    );
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("accepts streaming=true alias for partial preview mode", async () => {
    await runSingleChunkFinalScenario({ streaming: true, maxLinesPerMessage: 5 });

    expect(editMessageDiscord).toHaveBeenCalledWith(
      "c1",
      "preview-1",
      { content: "Hello\nWorld" },
      { rest: {} },
    );
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("falls back to standard send when final needs multiple chunks", async () => {
    await runSingleChunkFinalScenario({ streamMode: "partial", maxLinesPerMessage: 1 });

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses reasoning payload delivery to Discord", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendBlockReply({ text: "thinking...", isReasoning: true });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 1 } };
    });

    const ctx = await createBaseContext({ discordConfig: { streamMode: "off" } });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("suppresses reasoning-tagged final payload delivery to Discord", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        text: "Reasoning:\nthis should stay internal",
        isReasoning: true,
      });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({ discordConfig: { streamMode: "off" } });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(deliverDiscordReply).not.toHaveBeenCalled();
    expect(editMessageDiscord).not.toHaveBeenCalled();
  });

  it("delivers non-reasoning block payloads to Discord", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendBlockReply({ text: "hello from block stream" });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 1 } };
    });

    const ctx = await createBaseContext({ discordConfig: { streamMode: "off" } });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("streams block previews using draft chunking", async () => {
    const draftStream = createMockDraftStream();
    createDiscordDraftStream.mockReturnValueOnce(draftStream);

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({ text: "HelloWorld" });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBlockModeContext();

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toEqual(["Hello", "HelloWorld"]);
  });

  it("forces new preview messages on assistant boundaries in block mode", async () => {
    const draftStream = createMockDraftStream();
    createDiscordDraftStream.mockReturnValueOnce(draftStream);

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({ text: "Hello" });
      await params?.replyOptions?.onAssistantMessageStart?.();
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBlockModeContext();

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
  });

  it("strips reasoning tags from partial stream updates", async () => {
    const draftStream = createMockDraftStream();
    createDiscordDraftStream.mockReturnValueOnce(draftStream);

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({
        text: "<thinking>Let me think about this</thinking>\nThe answer is 42",
      });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      discordConfig: { streamMode: "partial" },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    for (const text of updates) {
      expect(text).not.toContain("<thinking>");
    }
  });

  it("skips pure-reasoning partial updates without updating draft", async () => {
    const draftStream = createMockDraftStream();
    createDiscordDraftStream.mockReturnValueOnce(draftStream);

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({
        text: "Reasoning:\nThe user asked about X so I need to consider Y",
      });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      discordConfig: { streamMode: "partial" },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(draftStream.update).not.toHaveBeenCalled();
  });
});
