/**
 * Gateway WebSocket method handlers for MCP Apps.
 *
 * Exposes MCP tool and resource operations as standard gateway WS methods
 * so Mission Control (and other WS-connected clients) can invoke them
 * without opening a separate HTTP connection to the MCP loopback server.
 *
 * Methods provided:
 *   mcp.tools.list      (READ_SCOPE)
 *   mcp.tools.call      (WRITE_SCOPE)
 *   mcp.resources.list  (READ_SCOPE)
 *   mcp.resources.read  (READ_SCOPE)
 */
import crypto from "node:crypto";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { listResources, resolveResourceContent } from "../mcp-app-resources.js";
import { McpLoopbackToolCache } from "../mcp-http.runtime.js";
import { filterToolSchemaByVisibility, isToolVisibleTo } from "../mcp-http.schema.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateMcpToolsCallParams,
  validateMcpToolsListParams,
  validateMcpResourcesListParams,
  validateMcpResourcesReadParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Shared tool cache for gateway WS MCP method calls.
 *
 * Re-uses the same 30 s TTL caching strategy as the MCP loopback server
 * to keep tool resolution cheap for interactive clients.
 */
const wsToolCache = new McpLoopbackToolCache("ws");

function resolveMcpSessionKey(rawSessionKey: unknown): string {
  const cfg = loadConfig();
  const raw = typeof rawSessionKey === "string" ? rawSessionKey.trim() : "";
  return !raw || raw === "main" ? resolveMainSessionKey(cfg) : raw;
}

export const mcpHandlers: GatewayRequestHandlers = {
  // -------------------------------------------------------------------------
  // mcp.tools.list — list MCP tools, including _meta.ui for MCP App tools
  // -------------------------------------------------------------------------
  "mcp.tools.list": ({ params, respond, client }) => {
    if (!validateMcpToolsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mcp.tools.list params: ${formatValidationErrors(validateMcpToolsListParams.errors)}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const sessionKey = resolveMcpSessionKey(params.sessionKey);
    const senderIsOwner = Array.isArray(client?.connect?.scopes)
      ? client.connect.scopes.includes(ADMIN_SCOPE)
      : false;

    const { toolSchema } = wsToolCache.resolve({
      cfg,
      sessionKey,
      messageProvider: undefined,
      accountId: undefined,
      senderIsOwner,
    });

    const callerRole = params.callerRole;
    const filtered = filterToolSchemaByVisibility(toolSchema, callerRole);
    respond(true, { tools: filtered }, undefined);
  },

  // -------------------------------------------------------------------------
  // mcp.tools.call — execute an MCP tool by name
  // -------------------------------------------------------------------------
  "mcp.tools.call": async ({ params, respond, client }) => {
    if (!validateMcpToolsCallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mcp.tools.call params: ${formatValidationErrors(validateMcpToolsCallParams.errors)}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const sessionKey = resolveMcpSessionKey(params.sessionKey);
    const senderIsOwner = Array.isArray(client?.connect?.scopes)
      ? client.connect.scopes.includes(ADMIN_SCOPE)
      : false;

    const { tools, toolSchema } = wsToolCache.resolve({
      cfg,
      sessionKey,
      messageProvider: undefined,
      accountId: undefined,
      senderIsOwner,
    });

    const toolName = params.name;
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      respond(
        true,
        {
          content: [{ type: "text", text: `Tool not available: ${toolName}` }],
          isError: true,
        },
        undefined,
      );
      return;
    }

    // Enforce visibility: reject calls to tools the caller's role can't access.
    const callerRole = params.callerRole;
    const schemaEntry = toolSchema.find((s) => s.name === toolName);
    if (schemaEntry && !isToolVisibleTo(schemaEntry, callerRole)) {
      respond(
        true,
        {
          content: [{ type: "text", text: `Tool not available: ${toolName}` }],
          isError: true,
        },
        undefined,
      );
      return;
    }

    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
    const toolCallId = `mcp-ws-${crypto.randomUUID()}`;

    try {
      const result = await tool.execute(toolCallId, toolArgs);

      // Locate matching schema entry to include _meta.ui when present
      const meta = schemaEntry?._meta;

      const payload: Record<string, unknown> = {
        content: Array.isArray((result as { content?: unknown })?.content)
          ? (result as { content: unknown[] }).content
          : [{ type: "text", text: JSON.stringify(result) }],
        isError: false,
      };
      if (meta) {
        payload._meta = meta;
      }
      respond(true, payload, undefined);
    } catch (error) {
      const message = formatErrorMessage(error);
      respond(
        true,
        {
          content: [{ type: "text", text: message || "tool execution failed" }],
          isError: true,
        },
        undefined,
      );
    }
  },

  // -------------------------------------------------------------------------
  // mcp.resources.list — list registered ui:// resources
  // -------------------------------------------------------------------------
  "mcp.resources.list": ({ params, respond, client }) => {
    if (!validateMcpResourcesListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mcp.resources.list params: ${formatValidationErrors(validateMcpResourcesListParams.errors)}`,
        ),
      );
      return;
    }

    // Resolve the tool cache so syncMcpAppResources runs before reading the
    // registry.  Without this, a WS client hitting resources.list before any
    // tools.list/tools.call would see an empty or stale resource set.
    const cfg = loadConfig();
    const sessionKey = resolveMcpSessionKey(params.sessionKey);
    const senderIsOwner = Array.isArray(client?.connect?.scopes)
      ? client.connect.scopes.includes(ADMIN_SCOPE)
      : false;

    wsToolCache.resolve({
      cfg,
      sessionKey,
      messageProvider: undefined,
      accountId: undefined,
      senderIsOwner,
    });

    respond(true, { resources: listResources() }, undefined);
  },

  // -------------------------------------------------------------------------
  // mcp.resources.read — fetch HTML content for a ui:// resource
  // -------------------------------------------------------------------------
  "mcp.resources.read": async ({ params, respond, client }) => {
    if (!validateMcpResourcesReadParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid mcp.resources.read params: ${formatValidationErrors(validateMcpResourcesReadParams.errors)}`,
        ),
      );
      return;
    }

    // Resolve the tool cache so syncMcpAppResources runs before reading the
    // registry.  Without this, a WS client hitting resources.read before any
    // tools.list/tools.call would get "resource not found" for resources that
    // are declared via tool resourceSource but not yet synced.
    const cfg = loadConfig();
    const sessionKey = resolveMcpSessionKey(params.sessionKey);
    const senderIsOwner = Array.isArray(client?.connect?.scopes)
      ? client.connect.scopes.includes(ADMIN_SCOPE)
      : false;

    wsToolCache.resolve({
      cfg,
      sessionKey,
      messageProvider: undefined,
      accountId: undefined,
      senderIsOwner,
    });

    const uri = params.uri;
    const resolved = await resolveResourceContent(uri);
    if (!resolved.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.error));
      return;
    }

    respond(true, { contents: [resolved.content] }, undefined);
  },
};
