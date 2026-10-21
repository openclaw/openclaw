import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { throwIfSettledRejected } from "../infra/error-graph-internal.js";
import { createDeferredCore } from "../shared/deferred.js";
import { VERSION } from "../version.js";
import { OpenClawChannelBridge } from "./channel-bridge.js";
import {
  ClaudePermissionRequestSchema,
  type ClaudeChannelMode,
  extractAttachmentsFromMessage,
  summarizeResult,
  summarizeStructuredResult,
  toText,
} from "./channel-shared.js";

type OpenClawMcpServeOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  config?: OpenClawConfig;
  claudeChannelMode?: ClaudeChannelMode;
  verbose?: boolean;
};

async function resolveMcpConfig(config: OpenClawConfig | undefined): Promise<OpenClawConfig> {
  if (config) {
    return config;
  }
  const { captureRuntimeConfigAsyncReader } = await import("../config/config.js");
  return await captureRuntimeConfigAsyncReader()();
}

function getChannelMcpCapabilities(claudeChannelMode: ClaudeChannelMode) {
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

/** Serve the channel MCP server over stdio until transport or process shutdown. */
export async function serveOpenClawChannelMcp(opts: OpenClawMcpServeOptions = {}): Promise<void> {
  const cfg = await resolveMcpConfig(opts.config);
  const claudeChannelMode = opts.claudeChannelMode ?? "auto";
  const capabilities = getChannelMcpCapabilities(claudeChannelMode);
  const server = new McpServer(
    { name: "openclaw", version: VERSION },
    capabilities ? { capabilities } : undefined,
  );
  const bridge = new OpenClawChannelBridge(cfg, {
    gatewayUrl: opts.gatewayUrl,
    gatewayToken: opts.gatewayToken,
    gatewayPassword: opts.gatewayPassword,
    claudeChannelMode,
    verbose: opts.verbose ?? false,
  });
  bridge.setServer(server);

  server.server.setNotificationHandler(
    "notifications/claude/channel/permission_request",
    { params: ClaudePermissionRequestSchema.shape.params },
    async (params) => {
      await bridge.handleClaudePermissionRequest({
        requestId: params.request_id,
        toolName: params.tool_name,
        description: params.description,
        inputPreview: params.input_preview,
      });
    },
  );

  server.registerTool(
    "conversations_list",
    {
      description: "List OpenClaw channel-backed conversations available through session routes.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).optional(),
        search: z.string().optional(),
        channel: z.string().optional(),
        includeDerivedTitles: z.boolean().optional(),
        includeLastMessage: z.boolean().optional(),
      }),
    },
    async (args) => {
      const conversations = await bridge.listConversations(args);
      return summarizeStructuredResult("conversations", conversations.length, { conversations });
    },
  );

  server.registerTool(
    "conversation_get",
    {
      description: "Get one OpenClaw conversation by session key.",
      inputSchema: z.object({ session_key: z.string().min(1) }),
    },
    async ({ session_key }) => {
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
    },
  );

  server.registerTool(
    "messages_read",
    {
      description: "Read recent messages for one OpenClaw conversation.",
      inputSchema: z.object({
        session_key: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    },
    async ({ session_key, limit }) => {
      const messages = await bridge.readMessages(session_key, limit);
      return summarizeStructuredResult("messages", messages.length, { messages });
    },
  );

  server.registerTool(
    "attachments_fetch",
    {
      description: "List non-text attachments for a message in one OpenClaw conversation.",
      inputSchema: z.object({
        session_key: z.string().min(1),
        message_id: z.string().min(1),
      }),
    },
    async ({ session_key, message_id }) => {
      const message = await bridge.readMessage(session_key, message_id);
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
    },
  );

  server.registerTool(
    "events_poll",
    {
      description: "Poll queued OpenClaw conversation events since a cursor.",
      inputSchema: z.object({
        after_cursor: z.number().int().min(0).optional(),
        session_key: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    },
    async ({ after_cursor, session_key, limit }) => {
      const { events, nextCursor, gap } = bridge.pollEvents(
        { afterCursor: after_cursor ?? 0, sessionKey: toText(session_key) },
        limit,
      );
      return {
        ...summarizeResult("events", events.length),
        structuredContent: {
          events,
          next_cursor: nextCursor,
          ...(gap ? { gap } : {}),
        },
      };
    },
  );

  server.registerTool(
    "events_wait",
    {
      description: "Wait for the next queued OpenClaw conversation event.",
      inputSchema: z.object({
        after_cursor: z.number().int().min(0).optional(),
        session_key: z.string().optional(),
        timeout_ms: z.number().int().min(1).max(300_000).optional(),
      }),
    },
    async ({ after_cursor, session_key, timeout_ms }, extra) => {
      const { event, gap } = await bridge.waitForEvent(
        { afterCursor: after_cursor ?? 0, sessionKey: toText(session_key) },
        timeout_ms,
        extra.mcpReq.signal,
      );
      return {
        content: [
          {
            type: "text",
            text: event
              ? `event ${event.cursor}`
              : gap
                ? `event gap before ${gap.oldest_available_cursor}`
                : "timeout",
          },
        ],
        structuredContent: { event, ...(gap ? { gap } : {}) },
      };
    },
  );

  server.registerTool(
    "messages_send",
    {
      description: "Send a message back through the same OpenClaw conversation route.",
      inputSchema: z.object({
        session_key: z.string().min(1),
        text: z.string().min(1),
      }),
    },
    async ({ session_key, text }) => {
      const result = await bridge.sendMessage({ sessionKey: session_key, text });
      return {
        content: [{ type: "text", text: "sent" }],
        structuredContent: { result },
      };
    },
  );

  server.registerTool(
    "permissions_list_open",
    {
      description:
        "List open OpenClaw exec or plugin approval requests visible through the Gateway.",
      inputSchema: z.object({}),
    },
    async () => {
      const approvals = bridge.listPendingApprovals();
      return {
        ...summarizeResult("approvals", approvals.length),
        structuredContent: { approvals },
      };
    },
  );

  server.registerTool(
    "permissions_respond",
    {
      description: "Allow or deny one pending OpenClaw exec or plugin approval request.",
      inputSchema: z.object({
        kind: z.enum(["exec", "plugin"]),
        id: z.string().min(1),
        decision: z.enum(["allow-once", "allow-always", "deny"]),
      }),
    },
    async ({ kind, id, decision }) => {
      const result = await bridge.respondToApproval({ kind, id, decision });
      return {
        content: [{ type: "text", text: "approval resolved" }],
        structuredContent: { result },
      };
    },
  );
  const transport = new StdioServerTransport();

  let closePromise: Promise<void> | undefined;
  const { promise: closed, resolve: resolveClosed } = createDeferredCore();

  const shutdown = () => {
    if (closePromise) {
      return;
    }
    // Assign before cleanup starts so SDK transport-close reentry observes the same owner promise.
    closePromise = Promise.resolve().then(async () => {
      // Both lifecycle owners must always close; one failure cannot strand the other.
      const results = await Promise.allSettled([bridge.close(), server.close()]);
      throwIfSettledRejected(results, "OpenClaw channel MCP shutdown failed");
    });
    process.stdin.off("end", shutdown);
    process.stdin.off("close", shutdown);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    void closePromise.then(resolveClosed, resolveClosed);
  };

  transport["onclose"] = shutdown;
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await server.connect(transport);
    await bridge.start();
    await closed;
    await closePromise;
  } finally {
    shutdown();
    await closed;
    await closePromise;
  }
}
