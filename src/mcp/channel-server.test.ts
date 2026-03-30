import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { testState } from "../gateway/test-helpers.mocks.js";
import {
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  writeSessionStore,
} from "../gateway/test-helpers.server.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createOpenClawChannelMcpServer, OpenClawChannelBridge } from "./channel-server.js";

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

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createSessionStoreFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcp-channel-"));
  cleanupDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  return storePath;
}

async function seedSession(params: {
  storePath: string;
  sessionKey: string;
  sessionId: string;
  route: {
    channel: string;
    to: string;
    accountId?: string;
    threadId?: string | number;
  };
  entryOverrides?: Record<string, unknown>;
  transcriptMessages: Array<{ id: string; message: Record<string, unknown> }>;
}) {
  const transcriptPath = path.join(path.dirname(params.storePath), `${params.sessionId}.jsonl`);
  await writeSessionStore({
    entries: {
      [params.sessionKey.split(":").at(-1) ?? "main"]: {
        sessionId: params.sessionId,
        sessionFile: transcriptPath,
        updatedAt: Date.now(),
        lastChannel: params.route.channel,
        lastTo: params.route.to,
        lastAccountId: params.route.accountId,
        lastThreadId: params.route.threadId,
        ...params.entryOverrides,
      },
    },
    storePath: params.storePath,
  });
  await fs.writeFile(
    transcriptPath,
    [
      JSON.stringify({ type: "session", version: 1, id: params.sessionId }),
      ...params.transcriptMessages.map((entry) => JSON.stringify(entry)),
    ].join("\n"),
    "utf-8",
  );
  return transcriptPath;
}

async function connectMcp(params: {
  gatewayUrl: string;
  gatewayToken: string;
  claudeChannelMode?: "auto" | "on" | "off";
}) {
  const serverHarness = await createOpenClawChannelMcpServer({
    gatewayUrl: params.gatewayUrl,
    gatewayToken: params.gatewayToken,
    claudeChannelMode: params.claudeChannelMode ?? "auto",
  });
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await serverHarness.server.connect(serverTransport);
  await client.connect(clientTransport);
  await serverHarness.start();
  return {
    client,
    bridge: serverHarness.bridge,
    close: async () => {
      await client.close();
      await serverHarness.close();
    },
  };
}

async function connectMcpWithoutGateway(params?: { claudeChannelMode?: "auto" | "on" | "off" }) {
  const serverHarness = await createOpenClawChannelMcpServer({
    claudeChannelMode: params?.claudeChannelMode ?? "auto",
    verbose: false,
  });
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await serverHarness.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    bridge: serverHarness.bridge,
    close: async () => {
      await client.close();
      await serverHarness.close();
    },
  };
}

describe("openclaw channel mcp server", () => {
  describe("gateway-backed flows", () => {
    describe("gateway integration", () => {
      installGatewayTestHooks();

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
          if (method === "chat.history") {
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
        let mcp: Awaited<ReturnType<typeof connectMcp>> | null = null;
        try {
          mcp = await connectMcpWithoutGateway({
            claudeChannelMode: "off",
          });
          const connectedMcp = mcp;
          (
            connectedMcp.bridge as unknown as {
              gateway: { request: typeof gatewayRequest; stopAndWait: () => Promise<void> };
              readySettled: boolean;
              resolveReady: () => void;
            }
          ).gateway = {
            request: gatewayRequest,
            stopAndWait: async () => {},
          };
          (
            connectedMcp.bridge as unknown as {
              readySettled: boolean;
              resolveReady: () => void;
            }
          ).readySettled = true;
          (
            connectedMcp.bridge as unknown as {
              resolveReady: () => void;
            }
          ).resolveReady();

          const listed = (await connectedMcp.client.callTool({
            name: "conversations_list",
            arguments: {},
          })) as {
            structuredContent?: { conversations?: Array<Record<string, unknown>> };
          };
          expect(listed.structuredContent?.conversations).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                sessionKey,
                channel: "telegram",
                to: "-100123",
                accountId: "acct-1",
                threadId: 42,
              }),
            ]),
          );

          const read = (await connectedMcp.client.callTool({
            name: "messages_read",
            arguments: { session_key: sessionKey, limit: 5 },
          })) as {
            structuredContent?: { messages?: Array<Record<string, unknown>> };
          };
          expect(read.structuredContent?.messages?.[0]).toMatchObject({
            role: "assistant",
            content: [{ type: "text", text: "hello from transcript" }],
          });
          expect(read.structuredContent?.messages?.[1]).toMatchObject({
            __openclaw: {
              id: "msg-attachment",
            },
          });

          const attachments = (await connectedMcp.client.callTool({
            name: "attachments_fetch",
            arguments: { session_key: sessionKey, message_id: "msg-attachment" },
          })) as {
            structuredContent?: { attachments?: Array<Record<string, unknown>> };
            isError?: boolean;
          };
          expect(attachments.isError).not.toBe(true);
          expect(attachments.structuredContent?.attachments).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "image",
              }),
            ]),
          );
        } finally {
          await mcp?.close();
        }
      });

      test("emits Claude channel and permission notifications", async () => {
        const storePath = await createSessionStoreFile();
        const sessionKey = "agent:main:main";
        await seedSession({
          storePath,
          sessionKey,
          sessionId: "sess-claude",
          route: {
            channel: "imessage",
            to: "+15551234567",
          },
          transcriptMessages: [],
        });

        const harness = await createGatewaySuiteHarness();
        let mcp: Awaited<ReturnType<typeof connectMcp>> | null = null;
        try {
          const channelNotifications: Array<{ content: string; meta: Record<string, string> }> = [];
          const permissionNotifications: Array<{
            request_id: string;
            behavior: "allow" | "deny";
          }> = [];

          mcp = await connectMcp({
            gatewayUrl: `ws://127.0.0.1:${harness.port}`,
            gatewayToken: "test-gateway-token-1234567890",
            claudeChannelMode: "on",
          });
          mcp.client.setNotificationHandler(ClaudeChannelNotificationSchema, ({ params }) => {
            channelNotifications.push(params);
          });
          mcp.client.setNotificationHandler(ClaudePermissionNotificationSchema, ({ params }) => {
            permissionNotifications.push(params);
          });

          emitSessionTranscriptUpdate({
            sessionFile: path.join(path.dirname(storePath), "sess-claude.jsonl"),
            sessionKey,
            messageId: "msg-user-1",
            message: {
              role: "user",
              content: [{ type: "text", text: "hello Claude" }],
              timestamp: Date.now(),
            },
          });

          await vi.waitFor(() => {
            expect(channelNotifications).toHaveLength(1);
          });
          expect(channelNotifications[0]).toMatchObject({
            content: "hello Claude",
            meta: expect.objectContaining({
              session_key: sessionKey,
              channel: "imessage",
              to: "+15551234567",
              message_id: "msg-user-1",
            }),
          });

          await mcp.client.notification({
            method: "notifications/claude/channel/permission_request",
            params: {
              request_id: "abcde",
              tool_name: "Bash",
              description: "run npm test",
              input_preview: '{"cmd":"npm test"}',
            },
          });

          emitSessionTranscriptUpdate({
            sessionFile: path.join(path.dirname(storePath), "sess-claude.jsonl"),
            sessionKey,
            messageId: "msg-user-2",
            message: {
              role: "user",
              content: [{ type: "text", text: "yes abcde" }],
              timestamp: Date.now(),
            },
          });

          await vi.waitFor(() => {
            expect(permissionNotifications).toHaveLength(1);
          });
          expect(permissionNotifications[0]).toEqual({
            request_id: "abcde",
            behavior: "allow",
          });

          emitSessionTranscriptUpdate({
            sessionFile: path.join(path.dirname(storePath), "sess-claude.jsonl"),
            sessionKey,
            messageId: "msg-user-3",
            message: {
              role: "user",
              content: "plain string user turn",
              timestamp: Date.now(),
            },
          });

          await vi.waitFor(() => {
            expect(channelNotifications).toHaveLength(2);
          });
          expect(channelNotifications[1]).toMatchObject({
            content: "plain string user turn",
            meta: expect.objectContaining({
              session_key: sessionKey,
              message_id: "msg-user-3",
            }),
          });
        } finally {
          await mcp?.close();
          await harness.close();
        }
      });
    });

    test("sendMessage normalizes route metadata for gateway send", async () => {
      const bridge = new OpenClawChannelBridge({} as never, {
        claudeChannelMode: "off",
        verbose: false,
      });
      const gatewayRequest = vi.fn().mockResolvedValue({ ok: true, channel: "telegram" });

      (
        bridge as unknown as {
          gateway: { request: typeof gatewayRequest; stopAndWait: () => Promise<void> };
          readySettled: boolean;
          resolveReady: () => void;
        }
      ).gateway = {
        request: gatewayRequest,
        stopAndWait: async () => {},
      };
      (
        bridge as unknown as {
          readySettled: boolean;
          resolveReady: () => void;
        }
      ).readySettled = true;
      (
        bridge as unknown as {
          resolveReady: () => void;
        }
      ).resolveReady();

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

      expect(gatewayRequest).toHaveBeenCalledWith(
        "send",
        expect.objectContaining({
          to: "-100123",
          channel: "telegram",
          accountId: "acct-1",
          threadId: "42",
          sessionKey: "agent:main:main",
          message: "reply from mcp",
        }),
      );
    });

    test("lists routed sessions that only expose modern channel fields", async () => {
      const bridge = new OpenClawChannelBridge({} as never, {
        claudeChannelMode: "off",
        verbose: false,
      });
      const gatewayRequest = vi.fn().mockResolvedValue({
        sessions: [
          {
            key: "agent:main:channel-field",
            channel: "telegram",
            deliveryContext: {
              to: "-100111",
            },
          },
          {
            key: "agent:main:origin-field",
            origin: {
              provider: "imessage",
              accountId: "imessage-default",
              threadId: "thread-7",
            },
            deliveryContext: {
              to: "+15551230000",
            },
          },
        ],
      });

      (
        bridge as unknown as {
          gateway: { request: typeof gatewayRequest; stopAndWait: () => Promise<void> };
          readySettled: boolean;
          resolveReady: () => void;
        }
      ).gateway = {
        request: gatewayRequest,
        stopAndWait: async () => {},
      };
      (
        bridge as unknown as {
          readySettled: boolean;
          resolveReady: () => void;
        }
      ).readySettled = true;
      (
        bridge as unknown as {
          resolveReady: () => void;
        }
      ).resolveReady();

      await expect(bridge.listConversations()).resolves.toEqual([
        expect.objectContaining({
          sessionKey: "agent:main:channel-field",
          channel: "telegram",
          to: "-100111",
        }),
        expect.objectContaining({
          sessionKey: "agent:main:origin-field",
          channel: "imessage",
          to: "+15551230000",
          accountId: "imessage-default",
          threadId: "thread-7",
        }),
      ]);
    });

    test("swallows notification send errors after channel replies are matched", async () => {
      const bridge = new OpenClawChannelBridge({} as never, {
        claudeChannelMode: "on",
        verbose: false,
      });

      (
        bridge as unknown as {
          pendingClaudePermissions: Map<string, Record<string, unknown>>;
          server: { server: { notification: ReturnType<typeof vi.fn> } };
        }
      ).pendingClaudePermissions.set("abcde", {
        toolName: "Bash",
        description: "run npm test",
        inputPreview: '{"cmd":"npm test"}',
      });
      (
        bridge as unknown as {
          server: { server: { notification: ReturnType<typeof vi.fn> } };
        }
      ).server = {
        server: {
          notification: vi.fn().mockRejectedValue(new Error("Not connected")),
        },
      };

      await expect(
        (
          bridge as unknown as {
            handleSessionMessageEvent: (payload: Record<string, unknown>) => Promise<void>;
          }
        ).handleSessionMessageEvent({
          sessionKey: "agent:main:main",
          message: {
            role: "user",
            content: [{ type: "text", text: "yes abcde" }],
          },
        }),
      ).resolves.toBeUndefined();
    });

    test("waits for queued events through the MCP tool", async () => {
      const mcp = await connectMcpWithoutGateway({ claudeChannelMode: "off" });
      try {
        await (
          mcp.bridge as unknown as {
            handleSessionMessageEvent: (payload: Record<string, unknown>) => Promise<void>;
          }
        ).handleSessionMessageEvent({
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
        expect(waited.structuredContent?.event).toMatchObject({
          type: "message",
          sessionKey: "agent:main:main",
          messageId: "msg-2",
          role: "user",
          text: "inbound live message",
        });
      } finally {
        await mcp.close();
      }
    });
  });
});
