import crypto from "node:crypto";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicy,
} from "../agents/pi-tools.policy.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../agents/tool-policy-pipeline.js";
import {
  collectExplicitAllowlist,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
} from "../agents/tool-policy.js";
import { loadConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { logDebug, logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "../security/dangerous-tools.js";
import { normalizeMessageChannel, resolveGatewayMessageChannel } from "../utils/message-channel.js";
import { getHeader } from "./http-utils.js";

/** MCP loopback server runs on gateway port + this offset. */
export const MCP_PORT_OFFSET = 1;

const SERVER_NAME = "openclaw";
const SERVER_VERSION = "0.1.0";

/**
 * Supported MCP protocol versions (newest first).
 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"];

/**
 * Tools that Claude Code already provides natively — no point exposing via MCP.
 */
const NATIVE_TOOL_EXCLUDE = new Set(["read", "write", "edit", "apply_patch", "exec", "process"]);

// ---------- Tool resolution ----------

function resolveFilteredTools(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  messageProvider?: string;
  accountId?: string;
}) {
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({ config: params.cfg, sessionKey: params.sessionKey });

  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
  const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    accountId: params.accountId ?? null,
  });
  const subagentPolicy = isSubagentSessionKey(params.sessionKey)
    ? resolveSubagentToolPolicy(params.cfg)
    : undefined;

  const allTools = createOpenClawTools({
    agentSessionKey: params.sessionKey,
    agentChannel: resolveGatewayMessageChannel(params.messageProvider),
    agentAccountId: params.accountId,
    config: params.cfg,
    pluginToolAllowlist: collectExplicitAllowlist([
      profilePolicy,
      providerProfilePolicy,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      subagentPolicy,
    ]),
  });

  const policyFiltered = applyToolPolicyPipeline({
    // oxlint-disable-next-line typescript/no-explicit-any
    tools: allTools as any,
    // oxlint-disable-next-line typescript/no-explicit-any
    toolMeta: (tool) => getPluginToolMeta(tool as any),
    warn: logWarn,
    steps: [
      ...buildDefaultToolPolicyPipelineSteps({
        profilePolicy: profilePolicyWithAlsoAllow,
        profile,
        providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
        providerProfile,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        agentId,
      }),
      { policy: subagentPolicy, label: "subagent tools.allow" },
    ],
  });

  return policyFiltered.filter(
    (t) =>
      !NATIVE_TOOL_EXCLUDE.has(t.name) && !DEFAULT_GATEWAY_HTTP_TOOL_DENY.includes(t.name as never),
  );
}

// ---------- JSON-RPC helpers ----------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function jsonRpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

function jsonRpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

// ---------- Request handler ----------

/**
 * Flatten a top-level `anyOf`/`oneOf` union of objects into a single
 * `{ type: "object" }` schema by merging all variant properties.
 *
 * The Anthropic API rejects `anyOf`/`oneOf`/`allOf` at the input_schema
 * top level, and Claude Code forwards MCP tool schemas as-is.
 */
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
        // First variant wins for each property definition.
        if (!(key in mergedProps)) {
          mergedProps[key] = schema;
        }
      }
    }
    if (Array.isArray(variant.required)) {
      requiredSets.push(new Set((variant.required as string[] | undefined) ?? []));
    }
  }
  // Only mark a field as required if ALL variants require it.
  const required =
    requiredSets.length > 0
      ? [...requiredSets.reduce((a, b) => new Set([...a].filter((x) => b.has(x))))]
      : [];
  const { anyOf: _a, oneOf: _o, ...rest } = raw;
  return { ...rest, type: "object", properties: mergedProps, required };
}

function buildToolSchema(tools: ReturnType<typeof resolveFilteredTools>) {
  return tools.map((t) => {
    let raw =
      t.parameters && typeof t.parameters === "object"
        ? { ...(t.parameters as Record<string, unknown>) }
        : {};
    // Flatten anyOf/oneOf unions — Anthropic API forbids them at top level.
    if (raw.anyOf || raw.oneOf) {
      raw = flattenUnionSchema(raw);
    }
    if (raw.type !== "object") {
      raw.type = "object";
      if (!raw.properties) {
        raw.properties = {};
      }
    }
    return { name: t.name, description: t.description, inputSchema: raw };
  });
}

async function handleJsonRpc(
  msg: JsonRpcRequest,
  tools: ReturnType<typeof resolveFilteredTools>,
  toolSchema: ReturnType<typeof buildToolSchema>,
): Promise<object | null> {
  const { id, method, params } = msg;

  switch (method) {
    // ---- lifecycle ----
    case "initialize": {
      const clientVersion = (params?.protocolVersion as string) ?? "";
      const negotiated =
        SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === clientVersion) ??
        SUPPORTED_PROTOCOL_VERSIONS[0];
      logDebug(`mcp ← initialize (protocol=${clientVersion}, negotiated=${negotiated})`);
      return jsonRpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      logDebug(`mcp ← ${method}`);
      return null; // notification — no response

    // ---- tools ----
    case "tools/list":
      logDebug(`mcp ← tools/list (${toolSchema.length} tools)`);
      return jsonRpcResult(id, { tools: toolSchema });

    case "tools/call": {
      const toolName = params?.name as string;
      const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) {
        logWarn(`mcp ← tools/call: not found: ${toolName}`);
        return jsonRpcResult(id, {
          content: [{ type: "text", text: `Tool not available: ${toolName}` }],
          isError: true,
        });
      }
      const argsSummary = Object.keys(toolArgs).join(",") || "(none)";
      logDebug(`mcp ← tools/call: ${toolName} [${argsSummary}]`);
      const t0 = Date.now();
      try {
        // oxlint-disable-next-line typescript/no-explicit-any
        const result = await (tool as any).execute(`mcp-${crypto.randomUUID()}`, toolArgs);
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
        const elapsed = Date.now() - t0;
        const snippet = content[0]?.text?.slice(0, 120) ?? "";
        logDebug(`mcp → ${toolName} OK (${elapsed}ms) ${snippet}`);
        return jsonRpcResult(id, { content, isError: false });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const elapsed = Date.now() - t0;
        logWarn(`mcp → ${toolName} FAIL (${elapsed}ms): ${message}`);
        return jsonRpcResult(id, {
          content: [{ type: "text", text: message || "tool execution failed" }],
          isError: true,
        });
      }
    }

    default:
      logDebug(`mcp ← unknown method: ${method}`);
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

const MAX_BODY_BYTES = 1_048_576; // 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
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

// ---------- Token ----------

/**
 * Resolve the MCP loopback bearer token for the given openclawDir.
 * Reads from `<openclawDir>/mcp-token`; generates and persists a new one if absent.
 */
export function resolveMcpLoopbackToken(openclawDir: string): string {
  const tokenPath = path.join(openclawDir, "mcp-token");
  try {
    return fs.readFileSync(tokenPath, "utf-8").trim();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(openclawDir, { recursive: true });
  fs.writeFileSync(tokenPath, token, { encoding: "utf-8", mode: 0o600 });
  return token;
}

// ---------- MCP config file ----------

/**
 * Ensure the MCP config file exists at `~/.openclaw/mcp.json`.
 * Returns the absolute path to the config file.
 */
export function ensureMcpConfigFile(openclawDir: string, mcpPort: number): string {
  const filePath = path.join(openclawDir, "mcp.json");
  const config = {
    mcpServers: {
      openclaw: {
        type: "http",
        url: `http://127.0.0.1:${mcpPort}/mcp`,
        headers: {
          Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
          "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
          "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
          "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
        },
      },
    },
  };
  const content = JSON.stringify(config, null, 2) + "\n";

  try {
    const existing = fs.readFileSync(filePath, "utf-8");
    if (existing === content) {
      return filePath;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  fs.mkdirSync(openclawDir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ---------- MCP loopback HTTP server ----------

/**
 * Start a plain HTTP server on 127.0.0.1 dedicated to the MCP endpoint.
 *
 * Implements MCP Streamable HTTP transport (stateless mode) with plain
 * JSON responses — no SSE, no session state.
 */
export async function startMcpLoopbackServer(port: number): Promise<{
  close: () => Promise<void>;
}> {
  const openclawDir = path.join(os.homedir(), ".openclaw");
  const mcpToken = resolveMcpLoopbackToken(openclawDir);

  // Per-tool-context cache with TTL; clears when runtime config snapshot changes.
  const TOOL_CACHE_TTL_MS = 30_000;
  const toolCache = new Map<
    string,
    {
      tools: ReturnType<typeof resolveFilteredTools>;
      schema: ReturnType<typeof buildToolSchema>;
      time: number;
    }
  >();
  let toolCacheConfigRef: ReturnType<typeof loadConfig> | null = null;

  function getTools(params: {
    cfg: ReturnType<typeof loadConfig>;
    sessionKey: string;
    messageProvider?: string;
    accountId?: string;
  }) {
    if (toolCacheConfigRef && toolCacheConfigRef !== params.cfg) {
      toolCache.clear();
    }
    toolCacheConfigRef = params.cfg;
    const cacheKey = [params.sessionKey, params.messageProvider ?? "", params.accountId ?? ""].join(
      "\u0000",
    );
    const now = Date.now();
    const cached = toolCache.get(cacheKey);
    if (cached && now - cached.time < TOOL_CACHE_TTL_MS) {
      return { tools: cached.tools, toolSchema: cached.schema };
    }
    // Evict expired entries to prevent unbounded growth.
    for (const [key, entry] of toolCache) {
      if (now - entry.time >= TOOL_CACHE_TTL_MS) {
        toolCache.delete(key);
      }
    }
    const tools = resolveFilteredTools(params);
    const schema = buildToolSchema(tools);
    toolCache.set(cacheKey, { tools, schema, time: now });
    if (!tools.length) {
      logWarn("mcp: tool resolution returned 0 tools — plugins may not be loaded yet");
    }
    return { tools, toolSchema: schema };
  }

  const httpServer = createHttpServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }

    // Fast-path well-known OAuth endpoints — tell clients no auth needed.
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

    // GET = SSE stream — not supported in stateless mode.
    if (req.method === "GET") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }

    // DELETE = session termination — not applicable in stateless mode.
    if (req.method === "DELETE") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }

    // Bearer token auth check.
    const authHeader = getHeader(req, "authorization") ?? "";
    const expectedAuth = `Bearer ${mcpToken}`;
    if (authHeader !== expectedAuth) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // Content-Type check.
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
        const reqSessionKey = getHeader(req, "x-session-key")?.trim() || resolveMainSessionKey(cfg);
        const messageProvider =
          normalizeMessageChannel(getHeader(req, "x-openclaw-message-channel")) ?? undefined;
        const accountId = getHeader(req, "x-openclaw-account-id")?.trim() || undefined;
        const { tools, toolSchema } = getTools({
          cfg,
          sessionKey: reqSessionKey,
          messageProvider,
          accountId,
        });

        // Handle batch or single request.
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const responses: object[] = [];

        for (const msg of messages) {
          const result = await handleJsonRpc(msg, tools, toolSchema);
          if (result !== null) {
            responses.push(result);
          }
        }

        // If all messages were notifications, return 202 Accepted.
        if (responses.length === 0) {
          res.writeHead(202);
          res.end();
          return;
        }

        const payload = Array.isArray(parsed)
          ? JSON.stringify(responses)
          : JSON.stringify(responses[0]);

        res.writeHead(200, {
          "Content-Type": "application/json",
        });
        res.end(payload);
      } catch (err) {
        logWarn(
          `mcp: request handling failed: ${err instanceof Error ? err.message : String(err)}`,
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
      const cfg = loadConfig();
      const defaultSessionKey = resolveMainSessionKey(cfg);
      const { tools: initial } = getTools({ cfg, sessionKey: defaultSessionKey });
      logDebug(
        `mcp: loopback server listening on 127.0.0.1:${port} (${initial.length} tools, ttl=${TOOL_CACHE_TTL_MS}ms)`,
      );
      resolve();
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
