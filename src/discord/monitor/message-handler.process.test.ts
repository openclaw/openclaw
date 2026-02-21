import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EMOJIS } from "../../channels/status-reactions.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";

const reactMessageDiscord = vi.fn(async () => {});
const removeReactionDiscord = vi.fn(async () => {});
const editMessageDiscord = vi.fn(async () => ({}));
const deliverDiscordReply = vi.fn(async () => {});
const createDiscordDraftStream = vi.fn(() => ({
  update: vi.fn<(text: string) => void>(() => {}),
  flush: vi.fn(async () => {}),
  messageId: vi.fn(() => "preview-1"),
  clear: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  forceNewMessage: vi.fn(() => {}),
}));

type DispatchInboundParams = {
  dispatcher: {
    sendFinalReply: (payload: { text?: string }) => boolean | Promise<boolean>;
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
const readSessionUpdatedAt = vi.fn(() => undefined);
const resolveStorePath = vi.fn(() => "/tmp/openclaw-discord-process-test-sessions.json");

vi.mock("../send.js", () => ({
  reactMessageDiscord,
  removeReactionDiscord,
}));

vi.mock("../send.messages.js", () => ({
  editMessageDiscord,
}));

vi.mock("../draft-stream.js", () => ({
  createDiscordDraftStream,
}));

vi.mock("./reply-delivery.js", () => ({
  deliverDiscordReply,
}));

vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage,
}));

vi.mock("../../auto-reply/reply/reply-dispatcher.js", () => ({
  createReplyDispatcherWithTyping: vi.fn(
    (opts: { deliver: (payload: unknown, info: { kind: string }) => Promise<void> | void }) => ({
      dispatcher: {
        sendToolResult: vi.fn(() => true),
        sendBlockReply: vi.fn(() => true),
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
  readSessionUpdatedAt,
  resolveStorePath,
}));

const { processDiscordMessage } = await import("./message-handler.process.js");

const createBaseContext = createBaseDiscordMessageContext;

beforeEach(() => {
  vi.useRealTimers();
  reactMessageDiscord.mockClear();
  removeReactionDiscord.mockClear();
  editMessageDiscord.mockClear();
  deliverDiscordReply.mockClear();
  createDiscordDraftStream.mockClear();
  dispatchInboundMessage.mockReset();
  recordInboundSession.mockReset();
  readSessionUpdatedAt.mockReset();
  resolveStorePath.mockReset();
  dispatchInboundMessage.mockResolvedValue({
    queuedFinal: false,
    counts: { final: 0, tool: 0, block: 0 },
  });
  recordInboundSession.mockResolvedValue(undefined);
  readSessionUpdatedAt.mockReturnValue(undefined);
  resolveStorePath.mockReturnValue("/tmp/openclaw-discord-process-test-sessions.json");
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

describe("processDiscordMessage ack reactions", () => {
  it("skips ack reactions for group-mentions when mentions are not required", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(reactMessageDiscord).not.toHaveBeenCalled();
  });

  it("sends ack reactions for mention-gated guild messages when mentioned", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: true,
      effectiveWasMentioned: true,
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(reactMessageDiscord.mock.calls[0]).toEqual(["c1", "m1", "👀", { rest: {} }]);
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

    expect(reactMessageDiscord.mock.calls[0]).toEqual([
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
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
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
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toContain(DEFAULT_EMOJIS.stallSoft);
    expect(emojis).toContain(DEFAULT_EMOJIS.stallHard);
    expect(emojis).toContain(DEFAULT_EMOJIS.done);
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
});

describe("processDiscordMessage draft streaming", () => {
  it("finalizes via preview edit when final fits one chunk", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "Hello\nWorld" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      discordConfig: { streamMode: "partial", maxLinesPerMessage: 5 },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(editMessageDiscord).toHaveBeenCalledWith(
      "c1",
      "preview-1",
      { content: "Hello\nWorld" },
      { rest: {} },
    );
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("falls back to standard send when final needs multiple chunks", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "Hello\nWorld" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      discordConfig: { streamMode: "partial", maxLinesPerMessage: 1 },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("streams block previews using draft chunking", async () => {
    const draftStream = {
      update: vi.fn<(text: string) => void>(() => {}),
      flush: vi.fn(async () => {}),
      messageId: vi.fn(() => "preview-1"),
      clear: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      forceNewMessage: vi.fn(() => {}),
    };
    createDiscordDraftStream.mockReturnValueOnce(draftStream);

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({ text: "HelloWorld" });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
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

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toEqual(["Hello", "HelloWorld"]);
  });

  it("forces new preview messages on assistant boundaries in block mode", async () => {
    const draftStream = {
      update: vi.fn<(text: string) => void>(() => {}),
      flush: vi.fn(async () => {}),
      messageId: vi.fn(() => "preview-1"),
      clear: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      forceNewMessage: vi.fn(() => {}),
    };
    createDiscordDraftStream.mockReturnValueOnce(draftStream);

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({ text: "Hello" });
      await params?.replyOptions?.onAssistantMessageStart?.();
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
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

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
  });
});
