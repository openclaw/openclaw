// Skills MCP bridge HTTP handler.
// Serves the bearer-authenticated `/mcp` JSON-RPC endpoint that exposes the
// agent's workspace skills as MCP tools. Reuses the loopback MCP protocol and
// body helpers; auth is a dedicated bridge token, independent of gateway
// operator credentials, so external callers never gain gateway control.
import type { IncomingMessage, ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { getHeader } from "./http-auth-utils.js";
import {
  jsonRpcError,
  jsonRpcResult,
  MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcRequest,
} from "./mcp-http.protocol.js";
import {
  isMcpHttpBodyTimeoutError,
  isMcpHttpBodyTooLargeError,
  readMcpHttpBody,
  resolveMcpHttpBodyTimeoutMs,
} from "./mcp-http.request.js";
import type { SkillsMcpRuntimeConfig } from "./skills-mcp.config.js";
import {
  buildSkillsMcpTools,
  type SkillsMcpTool,
  type SkillsMcpToolSchemaEntry,
} from "./skills-mcp.tools.js";

const SKILLS_MCP_SERVER_NAME = "openclaw-skills";
const SKILLS_MCP_SERVER_VERSION = "0.1.0";

type SkillsMcpDispatchContext = {
  tools: Map<string, SkillsMcpTool>;
  toolSchema: SkillsMcpToolSchemaEntry[];
};

function readJsonRpcId(message: unknown): string | number | null | undefined {
  if (!isRecord(message)) {
    return null;
  }
  const id = message.id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : undefined;
}

function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
  return isRecord(message) && message.jsonrpc === "2.0" && typeof message.method === "string";
}

function negotiateProtocolVersion(requested: unknown): string {
  const supported = MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS as readonly string[];
  if (typeof requested === "string" && supported.includes(requested)) {
    return requested;
  }
  return supported[0];
}

async function handleToolCall(
  id: ReturnType<typeof readJsonRpcId>,
  params: Record<string, unknown> | undefined,
  tools: Map<string, SkillsMcpTool>,
): Promise<object> {
  const name = isRecord(params) && typeof params.name === "string" ? params.name : "";
  const args = isRecord(params) && isRecord(params.arguments) ? params.arguments : {};
  const tool = tools.get(name);
  if (!tool) {
    return jsonRpcResult(id, {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    });
  }
  try {
    const text = await tool.execute(args);
    return jsonRpcResult(id, { content: [{ type: "text", text }], isError: false });
  } catch (error) {
    return jsonRpcResult(id, {
      content: [{ type: "text", text: formatErrorMessage(error) }],
      isError: true,
    });
  }
}

async function dispatchSkillsMcpMessage(
  message: JsonRpcRequest,
  ctx: SkillsMcpDispatchContext,
): Promise<object | null> {
  const id = message.id;
  switch (message.method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: negotiateProtocolVersion(message.params?.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: SKILLS_MCP_SERVER_NAME, version: SKILLS_MCP_SERVER_VERSION },
      });
    case "ping":
      return jsonRpcResult(id, {});
    case "tools/list":
      return jsonRpcResult(id, { tools: ctx.toolSchema });
    case "tools/call":
      return await handleToolCall(id, message.params, ctx.tools);
    default:
      // Notifications carry no id and never expect a reply.
      if (message.method.startsWith("notifications/")) {
        return null;
      }
      return jsonRpcError(id, -32601, `Method not found: ${message.method}`);
  }
}

function endJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function handleBodyReadFailure(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    return;
  }
  if (isMcpHttpBodyTooLargeError(error)) {
    endJson(res, 413, { error: "payload_too_large" });
    return;
  }
  if (isMcpHttpBodyTimeoutError(error)) {
    endJson(res, 408, { error: "request_body_timeout" });
    return;
  }
  endJson(res, 400, jsonRpcError(null, -32700, "Parse error"));
}

/**
 * Handles a `/mcp` skills-bridge request. Returns `false` when the bridge is
 * disabled so the request falls through to the rest of the gateway router;
 * otherwise it fully answers the request and returns `true`.
 */
export async function handleSkillsMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { cfg: OpenClawConfig; runtimeCfg: SkillsMcpRuntimeConfig },
): Promise<boolean> {
  const { cfg, runtimeCfg } = opts;
  if (!runtimeCfg.enabled) {
    return false;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return true;
  }

  const authHeader = getHeader(req, "authorization") ?? "";
  if (!safeEqualSecret(authHeader, `Bearer ${runtimeCfg.token}`)) {
    endJson(res, 401, { error: "unauthorized" });
    return true;
  }

  const contentType = getHeader(req, "content-type") ?? "";
  if (!contentType.startsWith("application/json")) {
    endJson(res, 415, { error: "unsupported_media_type" });
    return true;
  }

  let parsed: JsonRpcRequest | JsonRpcRequest[];
  try {
    const body = await readMcpHttpBody(req, { timeoutMs: resolveMcpHttpBodyTimeoutMs() });
    parsed = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
  } catch (error) {
    handleBodyReadFailure(res, error);
    return true;
  }

  const { tools, toolSchema } = buildSkillsMcpTools(cfg, runtimeCfg);
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const responses: object[] = [];
  for (const message of messages) {
    if (!isJsonRpcRequest(message)) {
      responses.push(jsonRpcError(readJsonRpcId(message), -32600, "Invalid Request"));
      continue;
    }
    const response = await dispatchSkillsMcpMessage(message, { tools, toolSchema });
    if (response !== null) {
      responses.push(response);
    }
  }

  if (responses.length === 0) {
    res.writeHead(202);
    res.end();
    return true;
  }

  const payload = Array.isArray(parsed) ? JSON.stringify(responses) : JSON.stringify(responses[0]);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(payload);
  return true;
}
