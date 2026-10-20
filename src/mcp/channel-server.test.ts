import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { OpenClawChannelBridge } from "./channel-bridge.js";
import { createChannelMcpRuntime } from "./channel-server-runtime.js";
import type { SessionMessagePayload } from "./channel-shared.js";

const route = { channel: "telegram", to: "-100123", accountId: "acct-1" };
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
    receive: receiveMessage.bind(null, serverHarness.bridge),
    call: call.bind(null, client),
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
    const sessionKey = "agent:main:telegram:direct:1";
    const mcp = await connectMcpWithoutGateway();
    const delivery = { channel: "telegram", to: "123", accountId: "one", threadId: "topic" };
    const fallback = { to: "+15551230000", accountId: "two", threadId: 42 };
    const transcript = [
      { id: "msg-1", role: "assistant", content: "transcript" },
      {
        __openclaw: { id: "attachment" },
        role: "assistant",
        content: [{ type: "text", text: "attached image" }, inlineImage],
      },
    ];
    const gatewayRequest = gatewayResponses({
      "sessions.list": {
        sessions: [
          { key: sessionKey, deliveryContext: delivery, lastMessagePreview: "hello" },
          { key: "agent:main:main", channel: "imessage", deliveryContext: fallback },
        ],
      },
      "sessions.get": { messages: transcript },
    });
    attachReadyGateway(mcp.bridge, gatewayRequest);

    const conversations = (await mcp.call("conversations_list", {})) as {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: { conversations: unknown[] };
    };
    expect(conversations.content?.[0]?.text).toContain(`"sessionKey": "${sessionKey}"`);
    expect(conversations.content?.[0]?.text).toContain(`"lastMessagePreview": "hello"`);
    expect(conversations.structuredContent?.conversations).toMatchObject([
      { sessionKey, ...delivery },
      { sessionKey: "agent:main:main", channel: "imessage", ...fallback },
    ]);

    const messages = (await mcp.call("messages_read", { session_key: sessionKey })) as {
      content?: Array<{ type: string; text?: string }>;
    };
    expect(messages.content?.[0]?.text).toContain(`"id": "msg-1"`);
    expect(messages.content?.[0]?.text).toContain("transcript");
    expect(messages).toHaveProperty("structuredContent.messages", transcript);
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
          message: { id: "media-1", role: "user", content, __openclaw: { media: [media] } },
        },
      });
      attachReadyGateway(mcp.bridge, gatewayRequest);

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
    const sessionKey = "agent:main:main";
    const mcp = await connectMcpWithoutGateway("on");
    const channels = notifications(mcp.client, "notifications/claude/channel", channelParams);
    const permissions = notifications(
      mcp.client,
      "notifications/claude/channel/permission",
      permissionParams,
    );

    await mcp.receive(
      userMessage([{ type: "text", text: "hello Claude" }], { messageId: "msg-user-1" }),
    );

    await flushMcpNotifications();
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

    await mcp.receive(
      userMessage([{ type: "text", text: "yes abcde" }], { messageId: "msg-user-2" }),
    );

    await flushMcpNotifications();
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

  test.each(["get", "send"] as const)(
    "%s uses the described conversation route",
    async (action) => {
      const sessionKey = "agent:main:main";
      const bridge = createBridge();
      const preview = "Use `[[reply_to_current]]` literally.";
      const gatewayRequest = vi.fn(async (method: string, _params: unknown) => {
        if (method === "sessions.describe") {
          return {
            session: {
              key: sessionKey,
              deliveryContext: { ...route, threadId: 42 },
              lastMessagePreview: preview,
            },
          };
        }
        if (action === "send" && method === "send") {
          return { ok: true };
        }
        throw new Error(`unexpected gateway method ${method}`);
      });
      attachReadyGateway(bridge, gatewayRequest);
      if (action === "get") {
        expect(await bridge.getConversation(sessionKey)).toMatchObject({
          sessionKey,
          ...route,
          threadId: 42,
          lastMessagePreview: preview,
        });
      } else {
        await bridge.sendMessage({ sessionKey, text: "reply from mcp" });
      }
      const expectedCalls: unknown[][] = [
        [
          "sessions.describe",
          { key: sessionKey, includeDerivedTitles: true, includeLastMessage: true },
        ],
      ];
      if (action === "send") {
        expectedCalls.push([
          "send",
          {
            ...route,
            threadId: "42",
            sessionKey,
            message: "reply from mcp",
            idempotencyKey: expect.any(String),
          },
        ]);
      }
      expect(gatewayRequest.mock.calls).toEqual(expectedCalls);
    },
  );

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
    await mcp.receive({
      sessionKey: "agent:main:main",
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
      messageId: "msg-2",
      messageSeq: 1,
      message: { role: "user", content: [{ type: "text", text: "live message" }] },
    });

    const waited = await mcp.call("events_wait", {
      session_key: "agent:main:main",
      after_cursor: 0,
      timeout_ms: 250,
    });
    expect(waited.structuredContent).toHaveProperty(
      "event",
      expect.objectContaining({
        type: "message",
        sessionKey: "agent:main:main",
        messageId: "msg-2",
        role: "user",
        text: "live message",
      }),
    );
  });

  test("reports cursor gaps and wakes filtered waits as queue eviction occurs", async () => {
    const mcp = await connectMcpWithoutGateway();
    const pendingFilteredWait = mcp.call("events_wait", {
      after_cursor: 0,
      session_key: "filtered",
      timeout_ms: 300_000,
    });
    await mcp.call("events_poll", { after_cursor: 0, session_key: "filtered" });
    for (let index = 1; index <= 1_001; index += 1) {
      await mcp.receive({
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

    const polled = await mcp.call("events_poll", { after_cursor: 0, limit: 1 });
    expect(polled.structuredContent).toMatchObject({
      gap: { requested_after_cursor: 0, oldest_available_cursor: 2 },
      next_cursor: 2,
    });

    const filteredPoll = await mcp.call("events_poll", {
      after_cursor: 0,
      session_key: "filtered",
    });
    expect(filteredPoll.structuredContent).toEqual({
      events: [],
      gap: { requested_after_cursor: 0, oldest_available_cursor: 2 },
      next_cursor: 1,
    });

    const waited = await mcp.call("events_wait", { after_cursor: 0, timeout_ms: 250 });
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
      { name: "events_wait", arguments: { after_cursor: 0, timeout_ms: 300_000 } },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(timerBaseline));

    controller.abort("client cancelled");
    await expect(waiting).rejects.toThrow();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(timerBaseline));
  });
});
