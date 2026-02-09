import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { parseRoutingAddress, toCanonicalAddress } from "./dispatch-from-config.js";
import { buildTestCtx } from "./test-ctx.js";

const mocks = vi.hoisted(() => ({
  routeReply: vi.fn(async () => ({ ok: true, messageId: "mock" })),
  tryFastAbortFromMessage: vi.fn(async () => ({
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

const { dispatchReplyFromConfig } = await import("./dispatch-from-config.js");
const { resetInboundDedupe } = await import("./inbound-dedupe.js");

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
  };
}

describe("dispatchReplyFromConfig", () => {
  beforeEach(() => {
    resetInboundDedupe();
    diagnosticMocks.logMessageQueued.mockReset();
    diagnosticMocks.logMessageProcessed.mockReset();
    diagnosticMocks.logSessionStateChange.mockReset();
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runMessageReceived.mockReset();
  });
  it("does not route when Provider matches OriginatingChannel (even if Surface is missing)", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: false,
      aborted: false,
    });
    mocks.routeReply.mockClear();
    const cfg = {} as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: undefined,
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts: GetReplyOptions | undefined,
      _cfg: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("routes when OriginatingChannel differs from Provider", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: false,
      aborted: false,
    });
    mocks.routeReply.mockClear();
    const cfg = {} as OpenClawConfig;
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
      _opts: GetReplyOptions | undefined,
      _cfg: OpenClawConfig,
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

  it("provides onToolResult in DM sessions", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: false,
      aborted: false,
    });
    mocks.routeReply.mockClear();
    const cfg = {} as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts: GetReplyOptions | undefined,
      _cfg: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      expect(typeof opts?.onToolResult).toBe("function");
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("does not provide onToolResult in group sessions", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: false,
      aborted: false,
    });
    const cfg = {} as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "group",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts: GetReplyOptions | undefined,
      _cfg: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeUndefined();
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("sends tool results via dispatcher in DM sessions", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: false,
      aborted: false,
    });
    const cfg = {} as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts: GetReplyOptions | undefined,
      _cfg: OpenClawConfig,
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

  it("does not provide onToolResult for native slash commands", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: false,
      aborted: false,
    });
    const cfg = {} as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      CommandSource: "native",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts: GetReplyOptions | undefined,
      _cfg: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeUndefined();
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("fast-aborts without calling the reply resolver", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
    });
    const cfg = {} as OpenClawConfig;
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
    const cfg = {} as OpenClawConfig;
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
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: false,
      aborted: false,
    });
    const cfg = {} as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      MessageSid: "msg-1",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver,
    });
    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("emits message_received hook with originating channel metadata", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: false,
      aborted: false,
    });
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const cfg = {} as OpenClawConfig;
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

  it("emits diagnostics when enabled", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: false,
      aborted: false,
    });
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
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: false,
      aborted: false,
    });
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      MessageSid: "msg-dup",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver,
    });
    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
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
  it("parses source:method:id (discord:channel:123)", () => {
    expect(parseRoutingAddress("discord:channel:123")).toEqual({
      source: "discord",
      method: "channel",
      id: "123",
    });
  });

  it("parses source:method:id (signal:group:abc)", () => {
    expect(parseRoutingAddress("signal:group:abc123")).toEqual({
      source: "signal",
      method: "group",
      id: "abc123",
    });
  });

  it("parses source:id (telegram:999)", () => {
    expect(parseRoutingAddress("telegram:999")).toEqual({
      source: "telegram",
      id: "999",
    });
  });

  it("parses source:id (whatsapp:+15555550123)", () => {
    expect(parseRoutingAddress("whatsapp:+15555550123")).toEqual({
      source: "whatsapp",
      id: "+15555550123",
    });
  });

  it("parses method:id (channel:123)", () => {
    expect(parseRoutingAddress("channel:123")).toEqual({
      method: "channel",
      id: "123",
    });
  });

  it("parses method:id (user:456)", () => {
    expect(parseRoutingAddress("user:456")).toEqual({
      method: "user",
      id: "456",
    });
  });

  it("parses method:id (group:abc)", () => {
    expect(parseRoutingAddress("group:abc123")).toEqual({
      method: "group",
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
      method: "room",
      id: "!abc:matrix.org",
    });
  });

  it("handles empty string", () => {
    expect(parseRoutingAddress("")).toEqual({ id: "" });
  });
});

describe("toCanonicalAddress", () => {
  it("builds discord:channel:id from channel: prefix", () => {
    expect(toCanonicalAddress("channel:123", { source: "discord" })).toBe("discord:channel:123");
  });

  it("builds discord:user:id from user: prefix", () => {
    expect(toCanonicalAddress("user:987", { source: "discord" })).toBe("discord:user:987");
  });

  it("preserves already-canonical discord:channel:id", () => {
    expect(toCanonicalAddress("discord:channel:123", { source: "discord" })).toBe(
      "discord:channel:123",
    );
  });

  it("builds telegram:user:id for DM", () => {
    expect(toCanonicalAddress("telegram:999", { source: "telegram", chatType: "direct" })).toBe(
      "telegram:user:999",
    );
  });

  it("builds telegram:group:id for group", () => {
    expect(toCanonicalAddress("telegram:999", { source: "telegram", chatType: "group" })).toBe(
      "telegram:group:999",
    );
  });

  it("builds whatsapp:user:id for DM", () => {
    expect(
      toCanonicalAddress("whatsapp:+15555550123", { source: "whatsapp", chatType: "direct" }),
    ).toBe("whatsapp:user:+15555550123");
  });

  it("builds whatsapp:group:id from raw JID", () => {
    expect(toCanonicalAddress("123@g.us", { source: "whatsapp", chatType: "group" })).toBe(
      "whatsapp:group:123@g.us",
    );
  });

  it("builds signal:user:id for DM", () => {
    expect(
      toCanonicalAddress("signal:+15555550123", { source: "signal", chatType: "direct" }),
    ).toBe("signal:user:+15555550123");
  });

  it("builds signal:group:id from group: prefix", () => {
    expect(toCanonicalAddress("group:abc123", { source: "signal" })).toBe("signal:group:abc123");
  });

  it("builds slack:channel:id from channel: prefix", () => {
    expect(toCanonicalAddress("channel:C123", { source: "slack", chatType: "channel" })).toBe(
      "slack:channel:C123",
    );
  });

  it("builds imessage:user:id for DM", () => {
    expect(toCanonicalAddress("imessage:sender", { source: "imessage", chatType: "direct" })).toBe(
      "imessage:user:sender",
    );
  });

  it("defaults method to user when chatType is missing", () => {
    expect(toCanonicalAddress("telegram:999", { source: "telegram" })).toBe("telegram:user:999");
  });

  it("defaults source to unknown when context is empty", () => {
    expect(toCanonicalAddress("123456789", {})).toBe("unknown:user:123456789");
  });

  it("returns undefined for null/undefined", () => {
    expect(toCanonicalAddress(null, { source: "discord" })).toBeUndefined();
    expect(toCanonicalAddress(undefined, { source: "discord" })).toBeUndefined();
  });

  it("returns undefined for empty/whitespace string", () => {
    expect(toCanonicalAddress("", { source: "discord" })).toBeUndefined();
    expect(toCanonicalAddress("   ", { source: "discord" })).toBeUndefined();
  });

  it("preserves existing canonical format idempotently", () => {
    expect(
      toCanonicalAddress("discord:channel:123", { source: "discord", chatType: "channel" }),
    ).toBe("discord:channel:123");
    expect(
      toCanonicalAddress("telegram:group:999", { source: "telegram", chatType: "group" }),
    ).toBe("telegram:group:999");
    expect(
      toCanonicalAddress("whatsapp:user:+15555550123", {
        source: "whatsapp",
        chatType: "direct",
      }),
    ).toBe("whatsapp:user:+15555550123");
  });
});
