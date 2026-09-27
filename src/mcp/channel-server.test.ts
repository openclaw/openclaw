// Channel MCP server tests cover channel tool registration and requests.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { OpenClawChannelBridge } from "./channel-bridge.js";
import { createChannelMcpRuntime } from "./channel-server-runtime.js";
import { extractAttachmentsFromMessage, type SessionMessagePayload } from "./channel-shared.js";

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

const ClaudeChannelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()),
  }),
});

const ClaudePermissionNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel/permission"),
  params: z.object({
    request_id: z.string(),
    behavior: z.enum(["allow", "deny"]),
  }),
});

async function connectMcpWithoutGateway(params?: { claudeChannelMode?: "auto" | "on" | "off" }) {
  const serverHarness = await createChannelMcpRuntime({
    claudeChannelMode: params?.claudeChannelMode ?? "auto",
    config: {} as never,
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

function attachReadyGateway(
  bridge: OpenClawChannelBridge,
  gatewayRequest: ReturnType<typeof vi.fn>,
) {
  const bridgeInternals = bridge as unknown as {
    gateway: { request: typeof gatewayRequest; stopAndWait: () => Promise<void> };
    readySettled: boolean;
    resolveReady: () => void;
  };
  bridgeInternals.gateway = {
    request: gatewayRequest,
    stopAndWait: async () => {},
  };
  bridgeInternals.readySettled = true;
  bridgeInternals.resolveReady();
}

async function flushMcpNotifications() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("openclaw channel mcp server", () => {
  describe("gateway-backed flows", () => {
    describe("gateway integration", () => {
      test("returns conversation and message payloads in primary MCP content", async () => {
        const sessionKey = "agent:main:telegram:direct:123";
        const mcp = await connectMcpWithoutGateway({ claudeChannelMode: "off" });
        const gatewayRequest = vi.fn(async (method: string) => {
          if (method === "sessions.list") {
            return {
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
            };
          }
          if (method === "sessions.get") {
            return {
              messages: [{ id: "msg-1", role: "assistant", content: "hello from transcript" }],
            };
          }
          throw new Error(`unexpected gateway method ${method}`);
        });
        attachReadyGateway(mcp.bridge, gatewayRequest);

        const conversations = (await mcp.client.callTool({
          name: "conversations_list",
          arguments: {},
        })) as {
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

        const messages = (await mcp.client.callTool({
          name: "messages_read",
          arguments: { session_key: sessionKey },
        })) as { content?: Array<{ type: string; text?: string }> };
        expect(messages.content?.[0]?.text).toContain(`"id": "msg-1"`);
        expect(messages.content?.[0]?.text).toContain("hello from transcript");
      });

      test("lists conversations and reads messages", async () => {
        const sessionKey = "agent:main:main";
        const gatewayRequest = vi.fn(async (method: string) => {
          if (method === "sessions.list") {
            return {
              sessions: [
                {
                  key: sessionKey,
                  channel: "telegram",
                  deliveryContext: {
                    to: "-100123",
                    accountId: "acct-1",
                    threadId: 42,
                  },
                },
              ],
            };
          }
          if (method === "sessions.get") {
            return {
              messages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: "hello from transcript" }],
                },
                {
                  __openclaw: {
                    id: "msg-attachment",
                  },
                  role: "assistant",
                  content: [
                    { type: "text", text: "attached image" },
                    {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: "image/png",
                        data: "abc",
                      },
                    },
                  ],
                },
              ],
            };
          }
          throw new Error(`unexpected gateway method ${method}`);
        });
        const bridge = createBridge();
        attachReadyGateway(bridge, gatewayRequest);

        const conversations = await bridge.listConversations();
        expect(conversations).toHaveLength(1);
        expect(conversations[0]?.sessionKey).toBe(sessionKey);
        expect(conversations[0]?.channel).toBe("telegram");
        expect(conversations[0]?.to).toBe("-100123");
        expect(conversations[0]?.accountId).toBe("acct-1");
        expect(conversations[0]?.threadId).toBe(42);

        const messages = await bridge.readMessages(sessionKey, 5);
        expect(messages[0]?.role).toBe("assistant");
        expect(messages[0]?.content).toEqual([{ type: "text", text: "hello from transcript" }]);
        expect((messages[1]?.["__openclaw"] as { id?: string } | undefined)?.id).toBe(
          "msg-attachment",
        );
        expect(
          extractAttachmentsFromMessage(messages[1]).some(
            (entry) => (entry as { type?: unknown }).type === "image",
          ),
        ).toBe(true);
      });

      test("fetches canonical persisted media by message id without scanning recent history", async () => {
        const mcp = await connectMcpWithoutGateway({ claudeChannelMode: "off" });
        const gatewayRequest = vi.fn(async (method: string, params: Record<string, unknown>) => {
          if (method === "chat.message.get") {
            expect(params).toEqual({
              sessionKey: "agent:main:main",
              messageId: "msg-canonical-media",
            });
            return {
              ok: true,
              message: {
                id: "msg-canonical-media",
                role: "user",
                content: "text-only transcript content",
                __openclaw: {
                  media: [
                    {
                      url: "media://inbound/photo.png",
                      contentType: "image/png",
                      kind: "image",
                      fileName: "photo.png",
                      sizeBytes: 123,
                    },
                  ],
                },
              },
            };
          }
          throw new Error(`unexpected gateway method ${method}`);
        });
        attachReadyGateway(mcp.bridge, gatewayRequest);

        const result = (await mcp.client.callTool({
          name: "attachments_fetch",
          arguments: {
            session_key: "agent:main:main",
            message_id: "msg-canonical-media",
          },
        })) as {
          structuredContent?: { attachments?: unknown[] };
        };

        expect(result.structuredContent?.attachments).toEqual([
          {
            type: "openclaw_media",
            media: {
              url: "media://inbound/photo.png",
              contentType: "image/png",
              kind: "image",
              fileName: "photo.png",
              sizeBytes: 123,
              transcribed: false,
            },
          },
        ]);
        expect(gatewayRequest).toHaveBeenCalledTimes(1);
      });

      test("clamps direct bridge session limits to the public MCP windows", async () => {
        const sessionKey = "agent:main:main";
        const gatewayRequest = vi.fn(async (method: string) => {
          if (method === "sessions.list") {
            return { sessions: [] };
          }
          if (method === "sessions.get") {
            return { messages: [] };
          }
          throw new Error(`unexpected gateway method ${method}`);
        });
        const bridge = createBridge();
        attachReadyGateway(bridge, gatewayRequest);

        await bridge.listConversations({ limit: 10_000 });
        await bridge.readMessages(sessionKey, 10_000);

        expect(gatewayRequest).toHaveBeenNthCalledWith(
          1,
          "sessions.list",
          expect.objectContaining({ limit: 500 }),
        );
        expect(gatewayRequest).toHaveBeenNthCalledWith(2, "sessions.get", {
          key: sessionKey,
          limit: 200,
        });
      });

      test("emits Claude channel and permission notifications", async () => {
        const sessionKey = "agent:main:main";
        const channelNotifications: Array<{ content: string; meta: Record<string, string> }> = [];
        const permissionNotifications: Array<{
          request_id: string;
          behavior: "allow" | "deny";
        }> = [];

        const mcp = await connectMcpWithoutGateway({
          claudeChannelMode: "on",
        });
        mcp.client.setNotificationHandler(ClaudeChannelNotificationSchema, ({ params }) => {
          channelNotifications.push(params);
        });
        mcp.client.setNotificationHandler(ClaudePermissionNotificationSchema, ({ params }) => {
          permissionNotifications.push(params);
        });

        await receiveMessage(mcp.bridge, {
          sessionKey,
          senderIsOwner: true,
          lastChannel: "imessage",
          lastTo: "+15551234567",
          messageId: "msg-user-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "hello Claude" }],
            timestamp: Date.now(),
          },
        });

        await flushMcpNotifications();
        expect(channelNotifications).toHaveLength(1);
        expect(channelNotifications[0]?.content).toBe("hello Claude");
        expect(channelNotifications[0]?.meta.session_key).toBe(sessionKey);
        expect(channelNotifications[0]?.meta.channel).toBe("imessage");
        expect(channelNotifications[0]?.meta.to).toBe("+15551234567");
        expect(channelNotifications[0]?.meta.message_id).toBe("msg-user-1");

        await mcp.client.notification({
          method: "notifications/claude/channel/permission_request",
          params: {
            request_id: "abcde",
            tool_name: "Bash",
            description: "run npm test",
            input_preview: '{"cmd":"npm test"}',
          },
        });

        await receiveMessage(mcp.bridge, {
          sessionKey,
          senderIsOwner: true,
          lastChannel: "imessage",
          lastTo: "+15551234567",
          messageId: "msg-user-2",
          message: {
            role: "user",
            content: [{ type: "text", text: "yes abcde" }],
            timestamp: Date.now(),
          },
        });

        await flushMcpNotifications();
        expect(permissionNotifications).toHaveLength(1);
        expect(permissionNotifications[0]).toEqual({
          request_id: "abcde",
          behavior: "allow",
        });

        await receiveMessage(mcp.bridge, {
          sessionKey,
          lastChannel: "imessage",
          lastTo: "+15551234567",
          messageId: "msg-user-3",
          message: {
            role: "user",
            content: "plain string user turn",
            timestamp: Date.now(),
          },
        });

        await flushMcpNotifications();
        expect(channelNotifications).toHaveLength(2);
        expect(channelNotifications[1]?.content).toBe("plain string user turn");
        expect(channelNotifications[1]?.meta.session_key).toBe(sessionKey);
        expect(channelNotifications[1]?.meta.message_id).toBe("msg-user-3");
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
      const gatewayRequest = vi.fn(async (method: string) => {
        if (method === "sessions.describe") {
          return {
            session: {
              key: "agent:main:main",
              deliveryContext: {
                channel: "telegram",
                to: "-100123",
                accountId: "acct-1",
              },
              lastMessagePreview: "Use `[[reply_to_current]]` literally.",
            },
          };
        }
        throw new Error(`unexpected gateway method ${method}`);
      });

      attachReadyGateway(bridge, gatewayRequest);

      const conversation = await bridge.getConversation("agent:main:main");
      expect(conversation?.sessionKey).toBe("agent:main:main");
      expect(conversation?.channel).toBe("telegram");
      expect(conversation?.to).toBe("-100123");
      expect(conversation?.accountId).toBe("acct-1");
      expect(conversation?.lastMessagePreview).toBe("Use `[[reply_to_current]]` literally.");
      expect(gatewayRequest).toHaveBeenCalledWith("sessions.describe", {
        key: "agent:main:main",
        includeDerivedTitles: true,
        includeLastMessage: true,
      });
    });

    test("waits for queued events through the MCP tool", async () => {
      const mcp = await connectMcpWithoutGateway({ claudeChannelMode: "off" });
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

      const waited = (await mcp.client.callTool({
        name: "events_wait",
        arguments: { session_key: "agent:main:main", after_cursor: 0, timeout_ms: 250 },
      })) as {
        structuredContent?: { event?: Record<string, unknown> };
      };
      expect(waited.structuredContent?.event?.type).toBe("message");
      expect(waited.structuredContent?.event?.sessionKey).toBe("agent:main:main");
      expect(waited.structuredContent?.event?.messageId).toBe("msg-2");
      expect(waited.structuredContent?.event?.role).toBe("user");
      expect(waited.structuredContent?.event?.text).toBe("inbound live message");
    });

    test("reports cursor gaps and wakes filtered waits as queue eviction occurs", async () => {
      const mcp = await connectMcpWithoutGateway({ claudeChannelMode: "off" });
      const pendingFilteredWait = mcp.client.callTool({
        name: "events_wait",
        arguments: {
          after_cursor: 0,
          session_key: "agent:main:filtered",
          timeout_ms: 300_000,
        },
      });
      await mcp.client.callTool({
        name: "events_poll",
        arguments: { after_cursor: 0, session_key: "agent:main:filtered" },
      });
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

      const polled = (await mcp.client.callTool({
        name: "events_poll",
        arguments: { after_cursor: 0, limit: 1 },
      })) as {
        structuredContent?: Record<string, unknown>;
      };
      expect(polled.structuredContent).toMatchObject({
        gap: { requested_after_cursor: 0, oldest_available_cursor: 2 },
        next_cursor: 2,
      });

      const filteredPoll = await mcp.client.callTool({
        name: "events_poll",
        arguments: { after_cursor: 0, session_key: "agent:main:filtered" },
      });
      expect(filteredPoll.structuredContent).toEqual({
        events: [],
        gap: { requested_after_cursor: 0, oldest_available_cursor: 2 },
        next_cursor: 1,
      });

      const waited = (await mcp.client.callTool({
        name: "events_wait",
        arguments: { after_cursor: 0, timeout_ms: 250 },
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
      const mcp = await connectMcpWithoutGateway({ claudeChannelMode: "off" });
      const timerBaseline = vi.getTimerCount();
      const controller = new AbortController();
      const waiting = mcp.client.callTool(
        {
          name: "events_wait",
          arguments: { after_cursor: 0, timeout_ms: 300_000 },
        },
        undefined,
        { signal: controller.signal },
      );
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(timerBaseline));

      controller.abort("client cancelled");
      await expect(waiting).rejects.toThrow();
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(timerBaseline));
    });
  });
});
