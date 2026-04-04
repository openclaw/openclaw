import crypto from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { loadConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { logDebug, logWarn } from "../logger.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { getHeader } from "./http-utils.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const SERVER_NAME = "openclaw";
const SERVER_VERSION = "0.1.0";
const MAX_BODY_BYTES = 1_048_576;
const TOOL_CACHE_TTL_MS = 30_000;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const;
const NATIVE_TOOL_EXCLUDE = new Set(["read", "write", "edit", "apply_patch", "exec", "process"]);

type JsonRpcId = string | number | null | undefined;
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

type McpLoopbackRuntime = {
  port: number;
  token: string;
};

let activeRuntime: McpLoopbackRuntime | undefined;

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

function flattenUnionSchema(raw: Record<string, unknown>): Record<string, unknown> {
  const variants = (raw.anyOf ?? raw.oneOf) as Record<string, unknown>[] | undefined;
  if (!Array.isArray(variants) || variants.length === 0) {
    return raw;
  }
  const mergedProps: Record<string, unknown> = {};
  const requiredSets: Set<string>[] = [];
  for (const variant of variants) {
    const props = variant.properties as Record<string, unknown> | undefined;
    if (props) {
      for (const [key, schema] of Object.entries(props)) {
        if (!(key in mergedProps)) {
          mergedProps[key] = schema;
          continue;
        }
        const existing = mergedProps[key] as Record<string, unknown>;
        const incoming = schema as Record<string, unknown>;
        if (Array.isArray(existing.enum) && Array.isArray(incoming.enum)) {
          mergedProps[key] = {
            ...existing,
            enum: [...new Set([...(existing.enum as unknown[]), ...(incoming.enum as unknown[])])],
          };
          continue;
        }
        if ("const" in existing && "const" in incoming && existing.const !== incoming.const) {
          const merged: Record<string, unknown> = {
            ...existing,
            enum: [existing.const, incoming.const],
          };
          delete merged.const;
          mergedProps[key] = merged;
          continue;
        }
        logWarn(
          `mcp loopback: conflicting schema definitions for "${key}", keeping the first variant`,
        );
      }
    }
    requiredSets.push(
      new Set(Array.isArray(variant.required) ? (variant.required as string[]) : []),
    );
  }
  const required =
    requiredSets.length > 0
      ? [
          ...requiredSets.reduce(
            (left, right) => new Set([...left].filter((key) => right.has(key))),
          ),
        ]
      : [];
  const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = raw;
  return { ...rest, type: "object", properties: mergedProps, required };
}

function buildToolSchema(tools: ReturnType<typeof resolveGatewayScopedTools>["tools"]) {
  return tools.map((tool) => {
    let raw =
      tool.parameters && typeof tool.parameters === "object"
        ? { ...(tool.parameters as Record<string, unknown>) }
        : {};
    if (raw.anyOf || raw.oneOf) {
      raw = flattenUnionSchema(raw);
    }
    if (raw.type !== "object") {
      raw.type = "object";
      if (!raw.properties) {
        raw.properties = {};
      }
    }
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: raw,
    };
  });
}

function resolveScopedSessionKey(
  cfg: ReturnType<typeof loadConfig>,
  rawSessionKey: string | undefined,
): string {
  const trimmed = rawSessionKey?.trim();
  return !trimmed || trimmed === "main" ? resolveMainSessionKey(cfg) : trimmed;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function getActiveMcpLoopbackRuntime(): McpLoopbackRuntime | undefined {
  return activeRuntime ? { ...activeRuntime } : undefined;
}

export function createMcpLoopbackServerConfig(port: number) {
  return {
    mcpServers: {
      openclaw: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: {
          Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
          "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
          "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
          "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
          "x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
        },
      },
    },
  };
}

async function handleJsonRpc(params: {
  message: JsonRpcRequest;
  tools: ReturnType<typeof resolveGatewayScopedTools>["tools"];
  toolSchema: ReturnType<typeof buildToolSchema>;
}): Promise<object | null> {
  const { id, method, params: methodParams } = params.message;

  switch (method) {
    case "initialize": {
      const clientVersion = (methodParams?.protocolVersion as string) ?? "";
      const negotiated =
        SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === clientVersion) ??
        SUPPORTED_PROTOCOL_VERSIONS[0];
      return jsonRpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "tools/list":
      return jsonRpcResult(id, { tools: params.toolSchema });
    case "tools/call": {
      const toolName = methodParams?.name as string;
      const toolArgs = (methodParams?.arguments ?? {}) as Record<string, unknown>;
      const tool = params.tools.find((candidate) => candidate.name === toolName);
      if (!tool) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: `Tool not available: ${toolName}` }],
          isError: true,
        });
      }
      const toolCallId = `mcp-${crypto.randomUUID()}`;
      try {
        // oxlint-disable-next-line typescript/no-explicit-any
        const result = await (tool as any).execute(toolCallId, toolArgs);
        const content =
          result?.content && Array.isArray(result.content)
            ? result.content.map((block: { type?: string; text?: string }) => ({
                type: (block.type ?? "text") as "text",
                text: block.text ?? (typeof block === "string" ? block : JSON.stringify(block)),
              }))
            : [
                {
                  type: "text",
                  text: typeof result === "string" ? result : JSON.stringify(result),
                },
              ];
        return jsonRpcResult(id, { content, isError: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonRpcResult(id, {
          content: [{ type: "text", text: message || "tool execution failed" }],
          isError: true,
        });
      }
    }
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function startMcpLoopbackServer(port = 0): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const token = crypto.randomBytes(32).toString("hex");
  const toolCache = new Map<
    string,
    {
      tools: ReturnType<typeof resolveGatewayScopedTools>["tools"];
      toolSchema: ReturnType<typeof buildToolSchema>;
      configRef: ReturnType<typeof loadConfig>;
      time: number;
    }
  >();

  const httpServer = createHttpServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad_request" }));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/.well-known/")) {
      res.writeHead(404);
      res.end();
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }

    const authHeader = getHeader(req, "authorization") ?? "";
    if (authHeader !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const contentType = getHeader(req, "content-type") ?? "";
    if (!contentType.startsWith("application/json")) {
      res.writeHead(415, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported_media_type" }));
      return;
    }

    void (async () => {
      try {
        const body = await readBody(req);
        const parsed: JsonRpcRequest | JsonRpcRequest[] = JSON.parse(body);
        const cfg = loadConfig();
        const sessionKey = resolveScopedSessionKey(cfg, getHeader(req, "x-session-key"));
        const messageProvider =
          normalizeMessageChannel(getHeader(req, "x-openclaw-message-channel")) ?? undefined;
        const accountId = getHeader(req, "x-openclaw-account-id")?.trim() || undefined;
        const cacheKey = [sessionKey, messageProvider ?? "", accountId ?? ""].join("\u0000");
        const now = Date.now();
        const cached = toolCache.get(cacheKey);
        const scopedTools =
          cached && cached.configRef === cfg && now - cached.time < TOOL_CACHE_TTL_MS
            ? cached
            : (() => {
                const next = resolveGatewayScopedTools({
                  cfg,
                  sessionKey,
                  messageProvider,
                  accountId,
                  excludeToolNames: NATIVE_TOOL_EXCLUDE,
                });
                const nextEntry = {
                  tools: next.tools,
                  toolSchema: buildToolSchema(next.tools),
                  configRef: cfg,
                  time: now,
                };
                toolCache.set(cacheKey, nextEntry);
                for (const [key, entry] of toolCache) {
                  if (now - entry.time >= TOOL_CACHE_TTL_MS) {
                    toolCache.delete(key);
                  }
                }
                return nextEntry;
              })();

        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const responses: object[] = [];
        for (const message of messages) {
          const response = await handleJsonRpc({
            message,
            tools: scopedTools.tools,
            toolSchema: scopedTools.toolSchema,
          });
          if (response !== null) {
            responses.push(response);
          }
        }

        if (responses.length === 0) {
          res.writeHead(202);
          res.end();
          return;
        }

        const payload = Array.isArray(parsed)
          ? JSON.stringify(responses)
          : JSON.stringify(responses[0]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(payload);
      } catch (error) {
        logWarn(
          `mcp loopback: request handling failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error")));
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("mcp loopback did not bind to a TCP port");
  }
  activeRuntime = { port: address.port, token };
  logDebug(`mcp loopback listening on 127.0.0.1:${address.port}`);

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (!error && activeRuntime?.token === token) {
            activeRuntime = undefined;
          }
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
