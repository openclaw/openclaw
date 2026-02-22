import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { parseRoutingAddress, toCanonicalAddress } from "./dispatch-from-config.js";
import { buildTestCtx } from "./test-ctx.js";

type AbortResult = { handled: boolean; aborted: boolean; stoppedSubagents?: number };

const mocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
  tryFastAbortFromMessage: vi.fn<() => Promise<AbortResult>>(async () => ({
    handled: false,
    aborted: false,
  })),
}));
const diagnosticMocks = vi.hoisted(() => ({
  logMessageQueued: vi.fn(),
  logMessageProcessed: vi.fn(),
  logSessionStateChange: vi.fn(),
}));
const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runMessageReceived: vi.fn(async () => {}),
  },
}));
const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => {}),
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) =>
    Boolean(
      channel &&
      ["telegram", "slack", "discord", "signal", "imessage", "whatsapp"].includes(channel),
    ),
  routeReply: mocks.routeReply,
}));

vi.mock("./abort.js", () => ({
  tryFastAbortFromMessage: mocks.tryFastAbortFromMessage,
  formatAbortReplyText: (stoppedSubagents?: number) => {
    if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
      return "⚙️ Agent was aborted.";
    }
    const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
    return `⚙️ Agent was aborted. Stopped ${stoppedSubagents} ${label}.`;
  },
}));

vi.mock("../../logging/diagnostic.js", () => ({
  logMessageQueued: diagnosticMocks.logMessageQueued,
  logMessageProcessed: diagnosticMocks.logMessageProcessed,
  logSessionStateChange: diagnosticMocks.logSessionStateChange,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: internalHookMocks.createInternalHookEvent,
  triggerInternalHook: internalHookMocks.triggerInternalHook,
}));

const { dispatchReplyFromConfig } = await import("./dispatch-from-config.js");
const { resetInboundDedupe } = await import("./inbound-dedupe.js");

const noAbortResult = { handled: false, aborted: false } as const;
const emptyConfig = {} as OpenClawConfig;
type DispatchReplyArgs = Parameters<typeof dispatchReplyFromConfig>[0];

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

function firstToolResultPayload(dispatcher: ReplyDispatcher): ReplyPayload | undefined {
  return (dispatcher.sendToolResult as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
    | ReplyPayload
    | undefined;
}

async function dispatchTwiceWithFreshDispatchers(params: Omit<DispatchReplyArgs, "dispatcher">) {
  await dispatchReplyFromConfig({
    ...params,
    dispatcher: createDispatcher(),
  });
  await dispatchReplyFromConfig({
    ...params,
    dispatcher: createDispatcher(),
  });
}

describe("dispatchReplyFromConfig", () => {
  beforeEach(() => {
    resetInboundDedupe();
    diagnosticMocks.logMessageQueued.mockClear();
    diagnosticMocks.logMessageProcessed.mockClear();
    diagnosticMocks.logSessionStateChange.mockClear();
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runMessageReceived.mockClear();
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockClear();
  });
  it("does not route when Provider matches OriginatingChannel (even if Surface is missing)", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: undefined,
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("routes when OriginatingChannel differs from Provider", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      AccountId: "acc-1",
      MessageThreadId: 123,
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:999",
        accountId: "acc-1",
        threadId: 123,
      }),
    );
  });

  it("routes media-only tool results when summaries are suppressed", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      ChatType: "group",
      AccountId: "acc-1",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      await opts?.onToolResult?.({
        text: "NO_REPLY",
        mediaUrls: ["https://example.com/tts-routed.opus"],
      });
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledTimes(1);
    const routed = mocks.routeReply.mock.calls[0]?.[0] as { payload?: ReplyPayload } | undefined;
    expect(routed?.payload?.mediaUrls).toEqual(["https://example.com/tts-routed.opus"]);
    expect(routed?.payload?.text).toBeUndefined();
  });

  it("provides onToolResult in DM sessions", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      expect(typeof opts?.onToolResult).toBe("function");
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses group tool summaries but still forwards tool media", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "group",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      await opts?.onToolResult?.({
        text: "NO_REPLY",
        mediaUrls: ["https://example.com/tts-group.opus"],
      });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    const sent = firstToolResultPayload(dispatcher);
    expect(sent?.mediaUrls).toEqual(["https://example.com/tts-group.opus"]);
    expect(sent?.text).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("sends tool results via dispatcher in DM sessions", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      // Simulate tool result emission
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ text: "🔧 exec: ls" }),
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses native tool summaries but still forwards tool media", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      CommandSource: "native",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      await opts?.onToolResult?.({ text: "🔧 tools/sessions_send" });
      await opts?.onToolResult?.({
        mediaUrl: "https://example.com/tts-native.opus",
      });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    const sent = firstToolResultPayload(dispatcher);
    expect(sent?.mediaUrl).toBe("https://example.com/tts-native.opus");
    expect(sent?.text).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("fast-aborts without calling the reply resolver", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
    });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Body: "/stop",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚙️ Agent was aborted.",
    });
  });

  it("fast-abort reply includes stopped subagent count when provided", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
      stoppedSubagents: 2,
    });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Body: "/stop",
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver: vi.fn(async () => ({ text: "hi" }) as ReplyPayload),
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚙️ Agent was aborted. Stopped 2 sub-agents.",
    });
  });

  it("deduplicates inbound messages by MessageSid and origin", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      MessageSid: "msg-1",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchTwiceWithFreshDispatchers({
      ctx,
      cfg,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("emits message_received hook with originating channel metadata", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "Telegram",
      OriginatingTo: "telegram:999",
      CommandBody: "/search hello",
      RawBody: "raw text",
      Body: "body text",
      Timestamp: 1710000000000,
      MessageSidFull: "sid-full",
      SenderId: "user-1",
      SenderName: "Alice",
      SenderUsername: "alice",
      SenderE164: "+15555550123",
      AccountId: "acc-1",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(hookMocks.runner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "whatsapp:user:+1000",
        content: "/search hello",
        timestamp: 1710000000000,
        metadata: expect.objectContaining({
          originatingChannel: "Telegram",
          originatingTo: "telegram:user:999",
          messageId: "sid-full",
          senderId: "user-1",
          senderName: "Alice",
          senderUsername: "alice",
          senderE164: "+15555550123",
        }),
      }),
      expect.objectContaining({
        channelId: "telegram",
        accountId: "acc-1",
        conversationId: "telegram:user:999",
      }),
    );
  });

  it("emits internal message:received hook when a session key is available", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      SessionKey: "agent:main:main",
      CommandBody: "/help",
      MessageSid: "msg-42",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      "agent:main:main",
      expect.objectContaining({
        from: ctx.From,
        content: "/help",
        channelId: "telegram",
        messageId: "msg-42",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("skips internal message:received hook when session key is unavailable", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      CommandBody: "/help",
    });
    (ctx as MsgContext).SessionKey = undefined;

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("emits diagnostics when enabled", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      SessionKey: "agent:main:main",
      MessageSid: "msg-1",
      To: "slack:C123",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(diagnosticMocks.logMessageQueued).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logSessionStateChange).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      state: "processing",
      reason: "message_start",
    });
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        outcome: "completed",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("normalizes Discord guild message to canonical discord:channel:id format", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: false,
      aborted: false,
    });
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const cfg = {} as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      ChatType: "channel",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:1467101506506592472",
      From: "discord:channel:1467101506506592472",
      To: "channel:1467101506506592472",
      SenderId: "123456789",
      SenderName: "TestUser",
      SenderUsername: "testuser",
      GroupSpace: "1466669509090869250",
      GroupChannel: "ops-openclaw",
      AccountId: "bot-1",
      Body: "hello",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(hookMocks.runner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "discord:channel:1467101506506592472",
        metadata: expect.objectContaining({
          to: "discord:channel:1467101506506592472",
          originatingTo: "discord:channel:1467101506506592472",
          senderId: "123456789",
          guildId: "1466669509090869250",
          channelName: "ops-openclaw",
        }),
      }),
      expect.objectContaining({
        channelId: "discord",
        accountId: "bot-1",
        conversationId: "discord:channel:1467101506506592472",
      }),
    );
  });

  it("normalizes Discord DM to canonical discord:user:id format", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: false,
      aborted: false,
    });
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const cfg = {} as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      OriginatingChannel: "discord",
      OriginatingTo: "user:987654321",
      From: "discord:987654321",
      To: "user:987654321",
      Body: "hello",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(hookMocks.runner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "discord:user:987654321",
        metadata: expect.objectContaining({
          to: "discord:user:987654321",
          originatingTo: "discord:user:987654321",
        }),
      }),
      expect.objectContaining({
        conversationId: "discord:user:987654321",
      }),
    );
  });

  it("marks diagnostics skipped for duplicate inbound messages", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      MessageSid: "msg-dup",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchTwiceWithFreshDispatchers({
      ctx,
      cfg,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        outcome: "skipped",
        reason: "duplicate",
      }),
    );
  });
});

describe("parseRoutingAddress", () => {
  it("parses provider:kind:id (discord:channel:123)", () => {
    expect(parseRoutingAddress("discord:channel:123")).toEqual({
      provider: "discord",
      kind: "channel",
      id: "123",
    });
  });

  it("parses provider:kind:id (signal:group:abc)", () => {
    expect(parseRoutingAddress("signal:group:abc123")).toEqual({
      provider: "signal",
      kind: "group",
      id: "abc123",
    });
  });

  it("parses provider:id (telegram:999)", () => {
    expect(parseRoutingAddress("telegram:999")).toEqual({
      provider: "telegram",
      id: "999",
    });
  });

  it("parses provider:id (whatsapp:+15555550123)", () => {
    expect(parseRoutingAddress("whatsapp:+15555550123")).toEqual({
      provider: "whatsapp",
      id: "+15555550123",
    });
  });

  it("parses kind:id (channel:123)", () => {
    expect(parseRoutingAddress("channel:123")).toEqual({
      kind: "channel",
      id: "123",
    });
  });

  it("parses kind:id (user:456)", () => {
    expect(parseRoutingAddress("user:456")).toEqual({
      kind: "user",
      id: "456",
    });
  });

  it("parses kind:id (group:abc)", () => {
    expect(parseRoutingAddress("group:abc123")).toEqual({
      kind: "group",
      id: "abc123",
    });
  });

  it("parses bare id (snowflake)", () => {
    expect(parseRoutingAddress("1467101506506592472")).toEqual({
      id: "1467101506506592472",
    });
  });

  it("parses bare id with special chars (WhatsApp JID)", () => {
    expect(parseRoutingAddress("123@g.us")).toEqual({
      id: "123@g.us",
    });
  });

  it("preserves colons in id (matrix room)", () => {
    expect(parseRoutingAddress("room:!abc:matrix.org")).toEqual({
      kind: "room",
      id: "!abc:matrix.org",
    });
  });

  it("handles empty string", () => {
    expect(parseRoutingAddress("")).toEqual({ id: "" });
  });
});

describe("toCanonicalAddress", () => {
  it("builds discord:channel:id from channel: prefix", () => {
    expect(toCanonicalAddress("channel:123", { provider: "discord" })).toBe("discord:channel:123");
  });

  it("builds discord:user:id from user: prefix", () => {
    expect(toCanonicalAddress("user:987", { provider: "discord" })).toBe("discord:user:987");
  });

  it("preserves already-canonical discord:channel:id", () => {
    expect(toCanonicalAddress("discord:channel:123", { provider: "discord" })).toBe(
      "discord:channel:123",
    );
  });

  it("builds telegram:user:id for DM", () => {
    expect(toCanonicalAddress("telegram:999", { provider: "telegram", chatType: "direct" })).toBe(
      "telegram:user:999",
    );
  });

  it("builds telegram:group:id for group", () => {
    expect(toCanonicalAddress("telegram:999", { provider: "telegram", chatType: "group" })).toBe(
      "telegram:group:999",
    );
  });

  it("builds whatsapp:user:id for DM", () => {
    expect(
      toCanonicalAddress("whatsapp:+15555550123", { provider: "whatsapp", chatType: "direct" }),
    ).toBe("whatsapp:user:+15555550123");
  });

  it("builds whatsapp:group:id from raw JID", () => {
    expect(toCanonicalAddress("123@g.us", { provider: "whatsapp", chatType: "group" })).toBe(
      "whatsapp:group:123@g.us",
    );
  });

  it("builds signal:user:id for DM", () => {
    expect(
      toCanonicalAddress("signal:+15555550123", { provider: "signal", chatType: "direct" }),
    ).toBe("signal:user:+15555550123");
  });

  it("builds signal:group:id from group: prefix", () => {
    expect(toCanonicalAddress("group:abc123", { provider: "signal" })).toBe("signal:group:abc123");
  });

  it("builds slack:channel:id from channel: prefix", () => {
    expect(toCanonicalAddress("channel:C123", { provider: "slack", chatType: "channel" })).toBe(
      "slack:channel:C123",
    );
  });

  it("builds imessage:user:id for DM", () => {
    expect(
      toCanonicalAddress("imessage:sender", { provider: "imessage", chatType: "direct" }),
    ).toBe("imessage:user:sender");
  });

  it("defaults kind to user when chatType is missing", () => {
    expect(toCanonicalAddress("telegram:999", { provider: "telegram" })).toBe("telegram:user:999");
  });

  it("defaults provider to unknown when context is empty", () => {
    expect(toCanonicalAddress("123456789", {})).toBe("unknown:user:123456789");
  });

  it("returns undefined for null/undefined", () => {
    expect(toCanonicalAddress(null, { provider: "discord" })).toBeUndefined();
    expect(toCanonicalAddress(undefined, { provider: "discord" })).toBeUndefined();
  });

  it("returns undefined for empty/whitespace string", () => {
    expect(toCanonicalAddress("", { provider: "discord" })).toBeUndefined();
    expect(toCanonicalAddress("   ", { provider: "discord" })).toBeUndefined();
  });

  it("preserves existing canonical format idempotently", () => {
    expect(
      toCanonicalAddress("discord:channel:123", { provider: "discord", chatType: "channel" }),
    ).toBe("discord:channel:123");
    expect(
      toCanonicalAddress("telegram:group:999", { provider: "telegram", chatType: "group" }),
    ).toBe("telegram:group:999");
    expect(
      toCanonicalAddress("whatsapp:user:+15555550123", {
        provider: "whatsapp",
        chatType: "direct",
      }),
    ).toBe("whatsapp:user:+15555550123");
  });
});
