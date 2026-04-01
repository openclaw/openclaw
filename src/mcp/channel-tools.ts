import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GatewayUnavailableError,
  type OpenClawChannelBridge,
  type OpenClawChannelBridgeDiagnostics,
} from "./channel-bridge.js";
import {
  extractAttachmentsFromMessage,
  resolveMessageId,
  summarizeResult,
  toText,
} from "./channel-shared.js";

const READY_TIMEOUT_MS = 2_000;

function gatewayUnavailableResult(
  toolName: string,
  diagnostics: OpenClawChannelBridgeDiagnostics,
) {
  return {
    content: [{ type: "text", text: `gateway unavailable: ${toolName}` }],
    structuredContent: {
      error: {
        code: "gateway_unavailable",
        tool: toolName,
        diagnostics,
      },
    },
    isError: true,
  };
}

async function withGatewayReadiness<T>(
  bridge: OpenClawChannelBridge,
  toolName: string,
  handler: () => Promise<T>,
): Promise<T | ReturnType<typeof gatewayUnavailableResult>> {
  try {
    await bridge.requireReady(READY_TIMEOUT_MS);
    return await handler();
  } catch (error) {
    if (error instanceof GatewayUnavailableError) {
      return gatewayUnavailableResult(toolName, error.diagnostics);
    }
    throw error;
  }
}

export function getChannelMcpCapabilities(claudeChannelMode: "off" | "on" | "auto") {
  if (claudeChannelMode === "off") {
    return undefined;
  }
  return {
    experimental: {
      "claude/channel": {},
      "claude/channel/permission": {},
    },
  };
}

export function registerChannelMcpTools(server: McpServer, bridge: OpenClawChannelBridge): void {
  server.tool("gateway_status", "Show OpenClaw MCP gateway bridge diagnostics.", {}, async () => {
    const gateway = bridge.getDiagnostics();
    return {
      content: [{ type: "text", text: `gateway ${gateway.state}` }],
      structuredContent: { gateway },
    };
  });

  server.tool(
    "conversations_list",
    "List OpenClaw channel-backed conversations available through session routes.",
    {
      limit: z.number().int().min(1).max(500).optional(),
      search: z.string().optional(),
      channel: z.string().optional(),
      includeDerivedTitles: z.boolean().optional(),
      includeLastMessage: z.boolean().optional(),
    },
    async (args) =>
      await withGatewayReadiness(bridge, "conversations_list", async () => {
      const conversations = await bridge.listConversations(args);
      return {
        ...summarizeResult("conversations", conversations.length),
        structuredContent: { conversations },
      };
      }),
  );

  server.tool(
    "conversation_get",
    "Get one OpenClaw conversation by session key.",
    { session_key: z.string().min(1) },
    async ({ session_key }) =>
      await withGatewayReadiness(bridge, "conversation_get", async () => {
      const conversation = await bridge.getConversation(session_key);
      if (!conversation) {
        return {
          content: [{ type: "text", text: `conversation not found: ${session_key}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `conversation ${conversation.sessionKey}` }],
        structuredContent: { conversation },
      };
      }),
  );

  server.tool(
    "messages_read",
    "Read recent messages for one OpenClaw conversation.",
    {
      session_key: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ session_key, limit }) =>
      await withGatewayReadiness(bridge, "messages_read", async () => {
      const messages = await bridge.readMessages(session_key, limit ?? 20);
      return {
        ...summarizeResult("messages", messages.length),
        structuredContent: { messages },
      };
      }),
  );

  server.tool(
    "attachments_fetch",
    "List non-text attachments for a message in one OpenClaw conversation.",
    {
      session_key: z.string().min(1),
      message_id: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ session_key, message_id, limit }) =>
      await withGatewayReadiness(bridge, "attachments_fetch", async () => {
      const messages = await bridge.readMessages(session_key, limit ?? 100);
      const message = messages.find((entry) => resolveMessageId(entry) === message_id);
      if (!message) {
        return {
          content: [{ type: "text", text: `message not found: ${message_id}` }],
          isError: true,
        };
      }
      const attachments = extractAttachmentsFromMessage(message);
      return {
        ...summarizeResult("attachments", attachments.length),
        structuredContent: { attachments, message },
      };
      }),
  );

  server.tool(
    "events_poll",
    "Poll queued OpenClaw conversation events since a cursor.",
    {
      after_cursor: z.number().int().min(0).optional(),
      session_key: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ after_cursor, session_key, limit }) =>
      await withGatewayReadiness(bridge, "events_poll", async () => {
      const { events, nextCursor } = bridge.pollEvents(
        { afterCursor: after_cursor ?? 0, sessionKey: toText(session_key) },
        limit ?? 20,
      );
      return {
        ...summarizeResult("events", events.length),
        structuredContent: { events, next_cursor: nextCursor },
      };
      }),
  );

  server.tool(
    "events_wait",
    "Wait for the next queued OpenClaw conversation event.",
    {
      after_cursor: z.number().int().min(0).optional(),
      session_key: z.string().optional(),
      timeout_ms: z.number().int().min(1).max(300_000).optional(),
    },
    async ({ after_cursor, session_key, timeout_ms }) =>
      await withGatewayReadiness(bridge, "events_wait", async () => {
      const event = await bridge.waitForEvent(
        { afterCursor: after_cursor ?? 0, sessionKey: toText(session_key) },
        timeout_ms ?? 30_000,
      );
      return {
        content: [{ type: "text", text: event ? `event ${event.cursor}` : "timeout" }],
        structuredContent: { event },
      };
      }),
  );

  server.tool(
    "messages_send",
    "Send a message back through the same OpenClaw conversation route.",
    {
      session_key: z.string().min(1),
      text: z.string().min(1),
    },
    async ({ session_key, text }) =>
      await withGatewayReadiness(bridge, "messages_send", async () => {
      const result = await bridge.sendMessage({ sessionKey: session_key, text });
      return {
        content: [{ type: "text", text: "sent" }],
        structuredContent: { result },
      };
      }),
  );

  server.tool(
    "permissions_list_open",
    "List open OpenClaw exec or plugin approval requests visible through the Gateway.",
    {},
    async () =>
      await withGatewayReadiness(bridge, "permissions_list_open", async () => {
      const approvals = bridge.listPendingApprovals();
      return {
        ...summarizeResult("approvals", approvals.length),
        structuredContent: { approvals },
      };
      }),
  );

  server.tool(
    "permissions_respond",
    "Allow or deny one pending OpenClaw exec or plugin approval request.",
    {
      kind: z.enum(["exec", "plugin"]),
      id: z.string().min(1),
      decision: z.enum(["allow-once", "allow-always", "deny"]),
    },
    async ({ kind, id, decision }) =>
      await withGatewayReadiness(bridge, "permissions_respond", async () => {
      const result = await bridge.respondToApproval({ kind, id, decision });
      return {
        content: [{ type: "text", text: "approval resolved" }],
        structuredContent: { result },
      };
      }),
  );
}
