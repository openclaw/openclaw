import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { OpenClawChannelBridge } from "./channel-bridge.js";
import { createChannelMcpRuntime } from "./channel-server-runtime.js";
import type { SessionMessagePayload } from "./channel-shared.js";

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

function createBridge() {
  const bridge = new OpenClawChannelBridge({}, { claudeChannelMode: "off", verbose: false });
  resources.push(bridge);
  return bridge;
}

function receiveMessage(bridge: OpenClawChannelBridge, payload: SessionMessagePayload) {
  return (
    bridge as unknown as {
      handleSessionMessageEvent: (payload: SessionMessagePayload) => Promise<void>;
    }
  ).handleSessionMessageEvent(payload);
}

function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

function gatewayResponses(responses: Record<string, unknown>) {
  return vi.fn(async (method: string) => {
    if (!(method in responses)) {
      throw new Error(`unexpected gateway method ${method}`);
    }
    return responses[method];
  });
}

const channelParams = z.object({
  content: z.string(),
  meta: z.record(z.string(), z.string()),
});

const permissionParams = z.object({
  request_id: z.string(),
  behavior: z.enum(["allow", "deny"]),
});

async function connectMcpWithoutGateway(claudeChannelMode: "on" | "off" = "off") {
  const serverHarness = await createChannelMcpRuntime({
    claudeChannelMode,
    config: {},
    verbose: false,
  });
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await serverHarness.server.connect(serverTransport);
  await client.connect(clientTransport);
  const mcp = {
    client,
    bridge: serverHarness.bridge,
    close: async () => {
      await client.close();
      await serverHarness.close();
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
    sessionKey: "agent:main:main",
    senderIsOwner: true,
    lastChannel: "imessage",
    lastTo: "+15551234567",
    message: { role: "user", content: text, timestamp: Date.now() },
    ...overrides,
  };
}

function attachReadyGateway(
  bridge: OpenClawChannelBridge,
  gatewayRequest: ReturnType<typeof vi.fn>,
) {
  const bridgeInternals = bridge as unknown as {
    gateway: { request: typeof gatewayRequest; stopAndWait: () => Promise<void> };
  };
  bridgeInternals.gateway = {
    request: gatewayRequest,
    stopAndWait: async () => {},
  };
  vi.spyOn(bridge, "waitUntilReady").mockResolvedValue();
}

async function flushMcpNotifications() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("openclaw channel mcp server", () => {
  test("returns conversation and message payloads in primary MCP content", async () => {
    const sessionKey = "agent:main:telegram:direct:123";
    const mcp = await connectMcpWithoutGateway();
    const gatewayRequest = gatewayResponses({
      "sessions.list": {
        sessions: [
          {
            key: sessionKey,
            deliveryContext: {
              channel: "telegram",
              to: "123",
              accountId: "acct-1",
              threadId: "thread-7",
            },
            lastMessagePreview: "hello",
          },
          {
            key: "agent:main:main",
            channel: "imessage",
            deliveryContext: { to: "+15551230000", accountId: "acct-2", threadId: 42 },
          },
        ],
      },
      "sessions.get": {
        messages: [
          { id: "msg-1", role: "assistant", content: "hello from transcript" },
          {
            __openclaw: { id: "msg-attachment" },
            role: "assistant",
            content: [{ type: "text", text: "attached image" }, inlineImage],
          },
        ],
      },
    });
    attachReadyGateway(mcp.bridge, gatewayRequest);

    const conversations = (await call(mcp.client, "conversations_list", {})) as {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: { conversations: unknown[] };
    };
    expect(conversations.content?.[0]?.text).toContain(`"sessionKey": "${sessionKey}"`);
    expect(conversations.content?.[0]?.text).toContain(`"lastMessagePreview": "hello"`);
    expect(conversations.structuredContent?.conversations).toMatchObject([
      { sessionKey, channel: "telegram", to: "123", accountId: "acct-1", threadId: "thread-7" },
      {
        sessionKey: "agent:main:main",
        channel: "imessage",
        to: "+15551230000",
        accountId: "acct-2",
        threadId: 42,
      },
    ]);

    const messages = (await call(mcp.client, "messages_read", { session_key: sessionKey })) as {
      content?: Array<{ type: string; text?: string }>;
    };
    expect(messages.content?.[0]?.text).toContain(`"id": "msg-1"`);
    expect(messages.content?.[0]?.text).toContain("hello from transcript");
    expect(messages).toMatchObject({
      structuredContent: {
        messages: [
          { id: "msg-1", role: "assistant", content: "hello from transcript" },
          {
            __openclaw: { id: "msg-attachment" },
            role: "assistant",
            content: [{ type: "text", text: "attached image" }, inlineImage],
          },
        ],
      },
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
      const gatewayRequest = gatewayResponses({
        "chat.message.get": {
          ok: true,
          message: {
            id: "msg-canonical-media",
            role: "user",
            content,
            __openclaw: { media: [media] },
          },
        },
      });
      attachReadyGateway(mcp.bridge, gatewayRequest);

      const result = (await call(mcp.client, "attachments_fetch", {
        session_key: "agent:main:main",
        message_id: "msg-canonical-media",
      })) as {
        structuredContent?: { attachments?: unknown[] };
      };

      expect(result.structuredContent?.attachments).toEqual([
        ...attachments,
        { type: "openclaw_media", media: { ...media, transcribed: false } },
      ]);
      expect(gatewayRequest).toHaveBeenCalledWith("chat.message.get", {
        sessionKey: "agent:main:main",
        messageId: "msg-canonical-media",
      });
      expect(gatewayRequest).toHaveBeenCalledTimes(1);
    },
  );

  test("emits Claude channel and permission notifications", async () => {
    const sessionKey = "agent:main:main";
    const channelNotifications: Array<{ content: string; meta: Record<string, string> }> = [];
    const permissionNotifications: Array<{
      request_id: string;
      behavior: "allow" | "deny";
    }> = [];

    const mcp = await connectMcpWithoutGateway("on");
    mcp.client.setNotificationHandler(
      "notifications/claude/channel",
      { params: channelParams },
      (params) => {
        channelNotifications.push(params);
      },
    );
    mcp.client.setNotificationHandler(
      "notifications/claude/channel/permission",
      { params: permissionParams },
      (params) => {
        permissionNotifications.push(params);
      },
    );

    await receiveMessage(
      mcp.bridge,
      userMessage([{ type: "text", text: "hello Claude" }], { messageId: "msg-user-1" }),
    );

    await flushMcpNotifications();
    expect(channelNotifications).toMatchObject([
      {
        content: "hello Claude",
        meta: {
          session_key: sessionKey,
          channel: "imessage",
          to: "+15551234567",
          message_id: "msg-user-1",
        },
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

    await receiveMessage(
      mcp.bridge,
      userMessage([{ type: "text", text: "yes abcde" }], { messageId: "msg-user-2" }),
    );

    await flushMcpNotifications();
    expect(permissionNotifications).toEqual([{ request_id: "abcde", behavior: "allow" }]);

    await receiveMessage(
      mcp.bridge,
      userMessage("plain string user turn", { messageId: "msg-user-3", senderIsOwner: undefined }),
    );

    await flushMcpNotifications();
    expect(channelNotifications).toHaveLength(2);
    expect(channelNotifications[1]).toMatchObject({
      content: "plain string user turn",
      meta: {
        session_key: sessionKey,
        message_id: "msg-user-3",
      },
    });
  });

  test("sendMessage normalizes route metadata for gateway send", async () => {
    const bridge = createBridge();
    const gatewayRequest = vi.fn().mockResolvedValue({ ok: true, channel: "telegram" });

    attachReadyGateway(bridge, gatewayRequest);

    vi.spyOn(bridge, "getConversation").mockResolvedValue({
      sessionKey: "agent:main:main",
      channel: "telegram",
      to: "-100123",
      accountId: "acct-1",
      threadId: 42,
    });

    await bridge.sendMessage({
      sessionKey: "agent:main:main",
      text: "reply from mcp",
    });

    expect(gatewayRequest).toHaveBeenCalledTimes(1);
    expect(gatewayRequest).toHaveBeenCalledWith("send", {
      to: "-100123",
      channel: "telegram",
      accountId: "acct-1",
      threadId: "42",
      sessionKey: "agent:main:main",
      message: "reply from mcp",
      idempotencyKey: expect.any(String),
    });
  });

  test("gets one conversation through sessions.describe without broad listing", async () => {
    const bridge = createBridge();
    const gatewayRequest = gatewayResponses({
      "sessions.describe": {
        session: {
          key: "agent:main:main",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "acct-1",
          },
          lastMessagePreview: "Use `[[reply_to_current]]` literally.",
        },
      },
    });

    attachReadyGateway(bridge, gatewayRequest);

    const conversation = await bridge.getConversation("agent:main:main");
    expect(conversation).toMatchObject({
      sessionKey: "agent:main:main",
      channel: "telegram",
      to: "-100123",
      accountId: "acct-1",
      lastMessagePreview: "Use `[[reply_to_current]]` literally.",
    });
    expect(gatewayRequest).toHaveBeenCalledWith("sessions.describe", {
      key: "agent:main:main",
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
  });

  test("rejects oversized limits and timeouts at the MCP input boundary", async () => {
    const mcp = await connectMcpWithoutGateway();
    attachReadyGateway(
      mcp.bridge,
      vi.fn(async () => ({ sessions: [], messages: [] })),
    );
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

  test("waits for queued events through the MCP tool", async () => {
    const mcp = await connectMcpWithoutGateway();
    await receiveMessage(mcp.bridge, {
      sessionKey: "agent:main:main",
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
      messageId: "msg-2",
      messageSeq: 1,
      message: {
        role: "user",
        content: [{ type: "text", text: "inbound live message" }],
      },
    });

    const waited = (await call(mcp.client, "events_wait", {
      session_key: "agent:main:main",
      after_cursor: 0,
      timeout_ms: 250,
    })) as {
      structuredContent?: { event?: Record<string, unknown> };
    };
    expect(waited.structuredContent?.event).toMatchObject({
      type: "message",
      sessionKey: "agent:main:main",
      messageId: "msg-2",
      role: "user",
      text: "inbound live message",
    });
  });

  test("reports cursor gaps and wakes filtered waits as queue eviction occurs", async () => {
    const mcp = await connectMcpWithoutGateway();
    const pendingFilteredWait = call(mcp.client, "events_wait", {
      after_cursor: 0,
      session_key: "agent:main:filtered",
      timeout_ms: 300_000,
    });
    await call(mcp.client, "events_poll", { after_cursor: 0, session_key: "agent:main:filtered" });
    for (let index = 1; index <= 1_001; index += 1) {
      await receiveMessage(mcp.bridge, {
        sessionKey: "agent:main:main",
        message: { role: "user", content: `event ${index}` },
      });
    }

    const filteredWait = await Promise.race([
      pendingFilteredWait,
      new Promise<undefined>((resolve) => {
        setImmediate(() => resolve(undefined));
      }),
    ]);
    expect(filteredWait?.structuredContent).toEqual({
      event: null,
      gap: { requested_after_cursor: 0, oldest_available_cursor: 2 },
    });

    const polled = (await call(mcp.client, "events_poll", { after_cursor: 0, limit: 1 })) as {
      structuredContent?: Record<string, unknown>;
    };
    expect(polled.structuredContent).toMatchObject({
      gap: { requested_after_cursor: 0, oldest_available_cursor: 2 },
      next_cursor: 2,
    });

    const filteredPoll = await call(mcp.client, "events_poll", {
      after_cursor: 0,
      session_key: "agent:main:filtered",
    });
    expect(filteredPoll.structuredContent).toEqual({
      events: [],
      gap: { requested_after_cursor: 0, oldest_available_cursor: 2 },
      next_cursor: 1,
    });

    const waited = (await call(mcp.client, "events_wait", {
      after_cursor: 0,
      timeout_ms: 250,
    })) as {
      structuredContent?: Record<string, unknown>;
    };
    expect(waited.structuredContent).toMatchObject({
      gap: { requested_after_cursor: 0, oldest_available_cursor: 2 },
      event: { cursor: 2 },
    });
  });

  test("cancels an events_wait bridge waiter through the MCP request signal", async () => {
    vi.useFakeTimers();
    const mcp = await connectMcpWithoutGateway();
    const timerBaseline = vi.getTimerCount();
    const controller = new AbortController();
    const waiting = mcp.client.callTool(
      {
        name: "events_wait",
        arguments: { after_cursor: 0, timeout_ms: 300_000 },
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(timerBaseline));

    controller.abort("client cancelled");
    await expect(waiting).rejects.toThrow();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(timerBaseline));
  });
});
