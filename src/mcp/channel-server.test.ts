import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createDeferredCore } from "../shared/deferred.js";
import { OpenClawChannelBridge } from "./channel-bridge.js";
import { serveOpenClawChannelMcp } from "./channel-server.js";
import type { SessionMessagePayload } from "./channel-shared.js";

const transportState = vi.hoisted((): { next?: InMemoryTransport } => ({}));
// mock-isolation: Channel fixtures read empty config without starting a config owner.
vi.mock("../config/config.js", () => ({
  captureRuntimeConfigAsyncReader: () => async () => ({}),
}));

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  StdioServerTransport: vi.fn(function () {
    if (!transportState.next) {
      throw new Error("MCP test transport was not prepared");
    }
    return transportState.next;
  }),
}));

const route = { channel: "telegram", to: "-100123", accountId: "acct-1" };
const sessionKey = "agent:main:main";
const inlineImage = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "abc" },
};
const resources: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function receiveMessage(bridge: OpenClawChannelBridge, payload: SessionMessagePayload) {
  return (
    bridge as unknown as {
      handleSessionMessageEvent: (payload: SessionMessagePayload) => Promise<void>;
    }
  ).handleSessionMessageEvent(payload);
}

function gatewayResponses(responses: Record<string, unknown>) {
  return vi.fn(async (method: string) => {
    if (!(method in responses)) {
      throw new Error(`unexpected gateway method ${method}`);
    }
    return responses[method];
  });
}

function primaryText(result: unknown) {
  return (result as { content: { text: string }[] }).content[0]?.text;
}

const channelParams = z.object({ content: z.string(), meta: z.record(z.string(), z.string()) });

const permissionParams = z.object({
  request_id: z.string(),
  behavior: z.enum(["allow", "deny"]),
});

function notifications<T>(client: Client, method: string, params: z.ZodType<T>) {
  const received: T[] = [];
  client.setNotificationHandler(method, { params }, (value) => {
    received.push(value);
  });
  return received;
}

async function connectMcpWithoutGateway(claudeChannelMode: "on" | "off" = "off") {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  transportState.next = serverTransport;
  const started = createDeferredCore<OpenClawChannelBridge>();
  const startSpy = vi
    .spyOn(OpenClawChannelBridge.prototype, "start")
    .mockImplementation(async function (this: OpenClawChannelBridge) {
      started.resolve(this);
    });
  const serving = serveOpenClawChannelMcp({
    claudeChannelMode,
    verbose: false,
  });
  void serving.catch(started.reject);
  const bridge = await started.promise;
  startSpy.mockRestore();
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  const mcp = {
    client,
    bridge,
    receive: receiveMessage.bind(null, bridge),
    call: (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close();
      await serverTransport.close();
      await serving;
    },
  };
  resources.push(mcp);
  return mcp;
}

function userMessage(
  text: unknown,
  overrides: Partial<SessionMessagePayload> = {},
): SessionMessagePayload {
  return {
    sessionKey,
    senderIsOwner: true,
    lastChannel: "imessage",
    lastTo: "+15551234567",
    message: { role: "user", content: text, timestamp: Date.now() },
    ...overrides,
  };
}

function attachReadyGateway(bridge: OpenClawChannelBridge, responses: Record<string, unknown>) {
  const gatewayRequest = gatewayResponses(responses);
  const bridgeInternals = bridge as unknown as {
    gateway: { request: typeof gatewayRequest; stopAndWait: () => Promise<void> };
  };
  bridgeInternals.gateway = {
    request: gatewayRequest,
    stopAndWait: async () => {},
  };
  vi.spyOn(bridge, "waitUntilReady").mockResolvedValue();
  return gatewayRequest;
}

async function flushMcpNotifications() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("openclaw channel mcp server", () => {
  test("lists, reads and replies through the described conversation", async () => {
    const conversationKey = "agent:main:telegram:direct:1";
    const mcp = await connectMcpWithoutGateway();
    const delivery = { channel: "telegram", to: "123", accountId: "one", threadId: "topic" };
    const fallback = { to: "+15551230000", accountId: "two", threadId: 42 };
    const preview = "Use `[[reply_to_current]]` literally.";
    const transcript = [
      { id: "msg-1", role: "assistant", content: "transcript" },
      {
        __openclaw: { id: "attachment" },
        role: "assistant",
        content: [{ type: "text", text: "attached image" }, inlineImage],
      },
    ];
    const gateway = attachReadyGateway(mcp.bridge, {
      "sessions.list": {
        sessions: [
          { key: conversationKey, deliveryContext: delivery, lastMessagePreview: "hello" },
          { key: "agent:main:main", channel: "imessage", deliveryContext: fallback },
        ],
      },
      "sessions.get": { messages: transcript },
      "sessions.describe": {
        session: {
          key: conversationKey,
          deliveryContext: { ...route, threadId: 42 },
          lastMessagePreview: preview,
        },
      },
      send: { ok: true },
    });
    const conversations = await mcp.call("conversations_list");
    expect(primaryText(conversations)).toContain(`"sessionKey": "${conversationKey}"`);
    expect(primaryText(conversations)).toContain('"lastMessagePreview": "hello"');
    expect(conversations).toHaveProperty("structuredContent.conversations", [
      expect.objectContaining({ sessionKey: conversationKey, ...delivery }),
      expect.objectContaining({ sessionKey: "agent:main:main", channel: "imessage", ...fallback }),
    ]);

    const messages = await mcp.call("messages_read", { session_key: conversationKey });
    expect(primaryText(messages)).toContain('"id": "msg-1"');
    expect(primaryText(messages)).toContain("transcript");
    expect(messages).toHaveProperty("structuredContent.messages", transcript);
    const described = await mcp.call("conversation_get", { session_key: conversationKey });
    expect(described.structuredContent).toMatchObject({
      conversation: {
        sessionKey: conversationKey,
        ...route,
        threadId: 42,
        lastMessagePreview: preview,
      },
    });
    expect(gateway).toHaveBeenCalledWith("sessions.describe", {
      key: conversationKey,
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
    await mcp.call("messages_send", { session_key: conversationKey, text: "reply from mcp" });
    expect(gateway).toHaveBeenLastCalledWith("send", {
      ...route,
      threadId: "42",
      sessionKey: conversationKey,
      message: "reply from mcp",
      idempotencyKey: expect.any(String),
    });
  });

  test.each([
    { content: "text-only transcript content", attachments: [] },
    {
      content: [{ type: "text", text: "attached image" }, inlineImage],
      attachments: [inlineImage],
    },
  ])(
    "fetches canonical media and $attachments without scanning recent history",
    async ({ content, attachments }) => {
      const mcp = await connectMcpWithoutGateway();
      const media = {
        url: "media://inbound/photo.png",
        contentType: "image/png",
        kind: "image",
        fileName: "photo.png",
        sizeBytes: 123,
      };
      const gatewayRequest = attachReadyGateway(mcp.bridge, {
        "chat.message.get": {
          ok: true,
          message: { id: "media-1", role: "user", content, __openclaw: { media: [media] } },
        },
      });
      const result = await mcp.call("attachments_fetch", {
        session_key: "agent:main:main",
        message_id: "media-1",
      });

      expect(result.structuredContent).toHaveProperty("attachments", [
        ...attachments,
        { type: "openclaw_media", media: { ...media, transcribed: false } },
      ]);
      expect(gatewayRequest).toHaveBeenCalledWith("chat.message.get", {
        sessionKey: "agent:main:main",
        messageId: "media-1",
      });
      expect(gatewayRequest).toHaveBeenCalledTimes(1);
    },
  );

  test("emits Claude channel and permission notifications", async () => {
    const mcp = await connectMcpWithoutGateway("on");
    const channels = notifications(mcp.client, "notifications/claude/channel", channelParams);
    const permissions = notifications(
      mcp.client,
      "notifications/claude/channel/permission",
      permissionParams,
    );

    const receive = async (text: unknown, messageId: string, senderIsOwner = true) => {
      await mcp.receive(userMessage(text, { messageId, senderIsOwner }));
      await flushMcpNotifications();
    };
    await receive([{ type: "text", text: "hello Claude" }], "msg-user-1");
    const meta = { session_key: sessionKey, channel: "imessage", to: "+15551234567" };
    expect(channels).toMatchObject([
      {
        content: "hello Claude",
        meta: { ...meta, message_id: "msg-user-1" },
      },
    ]);

    await mcp.client.notification({
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "abcde",
        tool_name: "Bash",
        description: "run npm test",
        input_preview: '{"cmd":"npm test"}',
      },
    });

    await receive([{ type: "text", text: "yes abcde" }], "msg-user-2");
    expect(permissions).toEqual([{ request_id: "abcde", behavior: "allow" }]);

    await mcp.receive(
      userMessage("plain turn", { messageId: "msg-user-3", senderIsOwner: undefined }),
    );
    await flushMcpNotifications();
    expect(channels).toHaveLength(2);
    expect(channels[1]).toMatchObject({
      content: "plain turn",
      meta: { session_key: sessionKey, message_id: "msg-user-3" },
    });
  });

  test("rejects oversized limits and timeouts at the MCP input boundary", async () => {
    const mcp = await connectMcpWithoutGateway();
    attachReadyGateway(mcp.bridge, {});
    for (const request of [
      { name: "conversations_list", arguments: { limit: 501 } },
      { name: "messages_read", arguments: { session_key: "agent:main:main", limit: 201 } },
      { name: "events_poll", arguments: { limit: 201 } },
      { name: "events_wait", arguments: { timeout_ms: 3_000_000_000 } },
    ]) {
      const result = await mcp.client.callTool(request);
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("Input validation error") }],
      });
    }
  });

  test("reads queued events then reports gaps and wakes filtered waits on eviction", async () => {
    const mcp = await connectMcpWithoutGateway();
    const pendingFilteredWait = mcp.call("events_wait", {
      after_cursor: 0,
      session_key: "filtered",
      timeout_ms: 300_000,
    });
    await mcp.call("events_poll", { after_cursor: 0, session_key: "filtered" });
    for (let index = 1; index <= 1_001; index += 1) {
      await mcp.receive({
        sessionKey,
        lastChannel: "telegram",
        lastTo: "-100123",
        lastAccountId: "acct-1",
        lastThreadId: 42,
        messageId: "msg-2",
        messageSeq: index,
        message: { role: "user", content: [{ type: "text", text: `event ${index}` }] },
      });
      if (index === 1) {
        const queued = await mcp.call("events_wait", {
          session_key: sessionKey,
          after_cursor: 0,
          timeout_ms: 250,
        });
        expect(queued.structuredContent).toMatchObject({
          event: { type: "message", sessionKey, messageId: "msg-2", role: "user", text: "event 1" },
        });
      }
    }

    const filteredWait = await Promise.race([
      pendingFilteredWait,
      new Promise<undefined>((resolve) => {
        setImmediate(() => resolve(undefined));
      }),
    ]);
    const gap = { requested_after_cursor: 0, oldest_available_cursor: 2 };
    expect(filteredWait?.structuredContent).toEqual({
      event: null,
      gap,
    });

    const polled = await mcp.call("events_poll", { after_cursor: 0, limit: 1 });
    expect(polled.structuredContent).toMatchObject({
      gap,
      next_cursor: 2,
    });

    const filteredPoll = await mcp.call("events_poll", {
      after_cursor: 0,
      session_key: "filtered",
    });
    expect(filteredPoll.structuredContent).toEqual({
      events: [],
      gap,
      next_cursor: 1,
    });

    const waited = await mcp.call("events_wait", { after_cursor: 0, timeout_ms: 250 });
    expect(waited.structuredContent).toMatchObject({
      gap,
      event: { cursor: 2 },
    });
  });

  test("cancels an events_wait bridge waiter through the MCP request signal", async () => {
    vi.useFakeTimers();
    const mcp = await connectMcpWithoutGateway();
    const timerBaseline = vi.getTimerCount();
    const controller = new AbortController();
    const waiting = mcp.client.callTool(
      { name: "events_wait", arguments: { after_cursor: 0, timeout_ms: 300_000 } },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(timerBaseline));

    controller.abort("client cancelled");
    await expect(waiting).rejects.toThrow();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(timerBaseline));
  });
});
