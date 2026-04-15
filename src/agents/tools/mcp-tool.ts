import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { getOrCreateSessionMcpRuntime } from "../pi-bundle-mcp-runtime.js";
import { type AnyAgentTool, jsonResult, readStringParam, ToolInputError } from "./common.js";

const MCP_ACTIONS = ["catalog", "call", "list_resources", "read_resource", "auth"] as const;

export const McpToolSchema = Type.Object(
  {
    action: Type.Optional(Type.Union(MCP_ACTIONS.map((entry) => Type.Literal(entry)))),
    server: Type.Optional(Type.String()),
    serverName: Type.Optional(Type.String()),
    tool: Type.Optional(Type.String()),
    toolName: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    input: Type.Optional(Type.Object({}, { additionalProperties: true })),
    arguments: Type.Optional(Type.Object({}, { additionalProperties: true })),
    uri: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

type McpToolOptions = {
  sessionId?: string;
  agentSessionKey?: string;
  workspaceDir: string;
  config?: OpenClawConfig;
};

function resolveRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function resolveRuntimeSessionId(options: McpToolOptions): string {
  const explicit = normalizeOptionalString(options.sessionId);
  if (explicit) {
    return explicit;
  }
  const bySessionKey = normalizeOptionalString(options.agentSessionKey);
  if (bySessionKey) {
    return bySessionKey;
  }
  return "session:default";
}

function resolveToolCallTarget(params: Record<string, unknown>): {
  serverName: string;
  toolName: string;
} {
  const rawServer =
    readStringParam(params, "serverName") ?? readStringParam(params, "server") ?? undefined;
  const rawTool = readStringParam(params, "toolName") ?? readStringParam(params, "tool") ?? undefined;
  const rawName = readStringParam(params, "name");

  if (rawServer && rawTool) {
    return { serverName: rawServer, toolName: rawTool };
  }

  if (rawName) {
    const separator = rawName.indexOf("__");
    if (separator > 0 && separator < rawName.length - 2) {
      return {
        serverName: rawName.slice(0, separator),
        toolName: rawName.slice(separator + 2),
      };
    }
  }

  throw new ToolInputError(
    "mcp call requires server+tool (serverName/toolName) or qualified name=<server>__<tool>",
  );
}

export function createMcpTool(options: McpToolOptions): AnyAgentTool {
  return {
    name: "mcp",
    label: "mcp",
    description:
      "Query bundle MCP catalog, invoke MCP tools, and provide compatibility actions for claw-code MCP tool names.",
    parameters: McpToolSchema,
    execute: async (_toolCallId, input) => {
      const params = resolveRecord(input);
      const action =
        (readStringParam(params, "action") as
          | "catalog"
          | "call"
          | "list_resources"
          | "read_resource"
          | "auth"
          | undefined) ?? "call";
      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: resolveRuntimeSessionId(options),
        sessionKey: options.agentSessionKey,
        workspaceDir: options.workspaceDir,
        cfg: options.config,
      });

      if (action === "catalog") {
        const catalog = await runtime.getCatalog();
        return jsonResult({
          status: "ok",
          action,
          catalog,
        });
      }

      if (action === "list_resources") {
        const catalog = await runtime.getCatalog();
        return jsonResult({
          status: "ok",
          action,
          resources: [],
          servers: catalog.servers,
          note: "bundle MCP runtime currently exposes tool catalog/call; resource listing is not yet surfaced.",
        });
      }

      if (action === "read_resource") {
        const uri = readStringParam(params, "uri", { required: true, label: "uri" });
        return jsonResult({
          status: "failed",
          action,
          uri,
          error:
            "bundle MCP runtime does not currently expose direct resource reads via this bridge.",
        });
      }

      if (action === "auth") {
        return jsonResult({
          status: "ok",
          action,
          note: "mcp auth handshake is delegated to server-specific runtime flows.",
        });
      }

      const { serverName, toolName } = resolveToolCallTarget(params);
      const toolInput = resolveRecord(params.input ?? params.arguments);
      const result = await runtime.callTool(serverName, toolName, toolInput);
      return jsonResult({
        status: "ok",
        action: "call",
        serverName,
        toolName,
        result,
      });
    },
  };
}

