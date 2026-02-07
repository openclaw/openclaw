import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import type { McpReadinessConfig, McpServerConfig, McpServersConfig } from "../config/types.mcp.js";
import { normalizeToolName } from "../agents/tool-policy.js";
import { logDebug, logInfo, logWarn } from "../logger.js";
import { resolveEffectiveMcpServers, isMcpServerEnabled } from "./resolve.js";

// Default readiness check configuration for HTTP/SSE servers.
const DEFAULT_READINESS: Required<McpReadinessConfig> = {
  retries: 5,
  initialDelayMs: 1_000,
  maxDelayMs: 10_000,
  timeoutMs: 30_000,
};

/**
 * Resolves the effective readiness config for a server.
 * HTTP/SSE servers get readiness checking by default unless explicitly disabled.
 * STDIO servers never get readiness checking (they manage their own lifecycle).
 */
function resolveReadinessConfig(server: McpServerConfig): Required<McpReadinessConfig> | null {
  const transport = (server as any).transport ?? "stdio";

  // STDIO servers don't need readiness checks — they manage their own process lifecycle.
  if (transport === "stdio") {
    return null;
  }

  const readiness = (server as any).readiness;

  // Explicitly disabled.
  if (readiness === false) {
    return null;
  }

  // Explicitly enabled with defaults, or an object with overrides.
  if (readiness === true || readiness === undefined) {
    return { ...DEFAULT_READINESS };
  }

  if (typeof readiness === "object" && readiness !== null) {
    return {
      retries: readiness.retries ?? DEFAULT_READINESS.retries,
      initialDelayMs: readiness.initialDelayMs ?? DEFAULT_READINESS.initialDelayMs,
      maxDelayMs: readiness.maxDelayMs ?? DEFAULT_READINESS.maxDelayMs,
      timeoutMs: readiness.timeoutMs ?? DEFAULT_READINESS.timeoutMs,
    };
  }

  return { ...DEFAULT_READINESS };
}

// NOTE: We keep these tool objects compatible with Pi Agent runtime and
// Claude Agent SDK tool bridging (via the existing MCP server bridge).

export type AnyAgentTool = AgentTool<any, unknown>;

export type McpRemoteToolDef = {
  name: string;
  description?: string;
  // MCP SDK returns JSON Schema objects.
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

type McpCallResult = {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
};

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  const t = typeof value;
  if (t === "string") {
    return JSON.stringify(value);
  }
  if (t === "number" || t === "boolean") {
    return JSON.stringify(value);
  }
  if (t !== "object") {
    // Handles bigint, symbol, function
    return JSON.stringify(
      typeof value === "bigint"
        ? value.toString()
        : String(value as string | symbol | ((...args: unknown[]) => unknown)),
    );
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).toSorted();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function stableHash(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function normalizeToolComponent(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function mcpPiToolName(serverId: string, toolName: string): string {
  const s = normalizeToolComponent(serverId) || "server";
  const t = normalizeToolComponent(toolName) || "tool";
  return `mcp__${s}__${t}`;
}

function coerceHeaders(headers: Record<string, string> | undefined): HeadersInit | undefined {
  if (!headers) {
    return undefined;
  }
  const entries = Object.entries(headers).filter(
    (e): e is [string, string] => typeof e[0] === "string" && typeof e[1] === "string",
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

/**
 * Detects if a server config requires authentication based on headers or environment
 */
function detectAuthRequired(server: McpServerConfig): boolean {
  // Check for auth headers (SSE and HTTP transports have headers)
  if ("headers" in server && server.headers && typeof server.headers === "object") {
    const headers = server.headers as Record<string, unknown>;
    const authKeys = ["authorization", "x-api-key", "x-auth-token", "token", "apikey"];
    return authKeys.some((key) =>
      Object.keys(headers).some((h) => h.toLowerCase().includes(key.toLowerCase())),
    );
  }

  // Check for auth-related environment variables (STDIO transport has env)
  if ("env" in server && server.env && typeof server.env === "object") {
    const env = server.env as Record<string, unknown>;
    const authKeys = ["token", "key", "secret", "password", "api_key", "auth"];
    return authKeys.some((key) =>
      Object.keys(env).some((e) => e.toLowerCase().includes(key.toLowerCase())),
    );
  }

  return false;
}

/**
 * Gets the transport type hint for a server config
 */
function getTransportHint(server: McpServerConfig): string {
  const transport = typeof server.transport === "string" ? server.transport : "stdio";
  if (transport === "http") return "[HTTP]";
  if (transport === "sse") return "[SSE]";
  return "[Local]"; // stdio
}

/**
 * Builds an enhanced tool description with context about the server and requirements
 */
function buildEnhancedDescription(
  toolName: string,
  toolDescription: string | undefined,
  serverId: string,
  serverLabel: string | undefined,
  server: McpServerConfig,
): string {
  const hasDescription = toolDescription && toolDescription.trim().length > 0;
  const baseDesc = hasDescription
    ? toolDescription.trim()
    : toolName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const hints: string[] = [];

  // Add transport type hint when description is explicitly empty OR for remote servers
  const transport = typeof server.transport === "string" ? server.transport : "stdio";
  const isExplicitlyEmpty = toolDescription !== undefined && toolDescription.trim().length === 0;
  if (isExplicitlyEmpty || transport === "http" || transport === "sse") {
    hints.push(getTransportHint(server));
  }

  // Add auth requirement hint
  if (detectAuthRequired(server)) {
    hints.push("[Requires Auth]");
  }

  const prefix = hints.length > 0 ? `${hints.join(" ")} ` : "";
  const serverRef = serverLabel?.trim() ? `via ${serverLabel}` : `via mcp:${serverId}`;

  return `${prefix}${baseDesc} (${serverRef})`;
}

/**
 * Enhances parameter descriptions with type information when missing
 */
function enhanceParameterDescription(
  param: Record<string, unknown>,
  paramName: string,
): Record<string, unknown> {
  if (typeof param.description === "string" && param.description.trim().length > 0) {
    // Already has a description
    return param;
  }

  // Build description from parameter name, type, and enum values
  const enhanced = { ...param };
  const displayName = paramName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const parts: string[] = [];
  const type = typeof param.type === "string" ? param.type : "unknown";
  parts.push(`${displayName} (${type})`);

  // Include enum values if present
  if (Array.isArray(param.enum) && param.enum.length > 0) {
    const enumValues = param.enum.map((v) => JSON.stringify(v)).join(", ");
    parts.push(`values: ${enumValues}`);
  }

  enhanced.description = parts.join("; ");
  return enhanced;
}

function stringifyToolResultContent(
  block: Record<string, unknown>,
): AgentToolResult<unknown>["content"][number] {
  const type = typeof block.type === "string" ? block.type : "";

  if (type === "text") {
    return { type: "text", text: typeof block.text === "string" ? block.text : "" };
  }

  if (type === "image") {
    const data = typeof block.data === "string" ? block.data : "";
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image/png";
    return { type: "image", data, mimeType };
  }

  // Unsupported content kinds in Pi tool results: audio/resource.
  // We preserve them as text so the model can still see useful output.
  if (type === "audio") {
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "audio/mpeg";
    return {
      type: "text",
      text: `[MCP audio content: ${mimeType} (${typeof block.data === "string" ? block.data.length : 0} base64 chars)]`,
    };
  }

  if (type === "resource") {
    const resource = (block.resource ?? {}) as Record<string, unknown>;
    const uri = typeof resource.uri === "string" ? resource.uri : "";
    const text = typeof resource.text === "string" ? resource.text : undefined;
    const blob = typeof resource.blob === "string" ? resource.blob : undefined;
    return {
      type: "text",
      text: text ?? (blob ? `[MCP resource blob: ${uri} (${blob.length} base64 chars)]` : uri),
    };
  }

  return { type: "text", text: JSON.stringify(block, null, 2) };
}

class McpConnection {
  readonly serverId: string;
  readonly server: McpServerConfig;

  private client: Client | null = null;
  private transport:
    | StdioClientTransport
    | SSEClientTransport
    | StreamableHTTPClientTransport
    | null = null;

  private connectPromise: Promise<void> | null = null;

  constructor(params: { serverId: string; server: McpServerConfig }) {
    this.serverId = params.serverId;
    this.server = params.server;
  }

  async connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = (async () => {
      const readiness = resolveReadinessConfig(this.server);
      if (readiness) {
        await this.connectWithReadiness(readiness);
      } else {
        await this.connectOnce();
      }
    })();

    return this.connectPromise;
  }

  /**
   * Retry-with-backoff connection for HTTP/SSE transports.
   * Creates the transport, connects, and verifies readiness by issuing
   * `tools/list` — if the remote server isn't up yet the connect or list
   * call will throw, and we retry with exponential backoff.
   */
  private async connectWithReadiness(config: Required<McpReadinessConfig>): Promise<void> {
    const { retries, initialDelayMs, maxDelayMs, timeoutMs } = config;
    const deadline = Date.now() + timeoutMs;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (Date.now() >= deadline) {
        break;
      }

      try {
        await this.connectOnce();
        // Verify the server actually responds to tools/list (the real readiness signal).
        if (this.client) {
          await this.client.listTools();
        }
        logInfo(
          `[mcp] Connected to remote MCP server "${this.serverId}" after ${attempt > 0 ? `${attempt} ${attempt === 1 ? "retry" : "retries"}` : "first attempt"}`,
        );
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Reset transport state so the next attempt creates a fresh connection.
        await this.resetTransport();

        if (attempt < retries && Date.now() < deadline) {
          const backoff = Math.min(maxDelayMs, initialDelayMs * 2 ** attempt);
          logWarn(
            `[mcp] Remote MCP server "${this.serverId}" not ready (attempt ${attempt + 1}/${retries + 1}): ${lastError.message}; retrying in ${backoff}ms`,
          );
          await new Promise<void>((resolve) => setTimeout(resolve, backoff));
        }
      }
    }

    throw new Error(
      `MCP server "${this.serverId}" failed readiness check after ${retries + 1} attempts: ${lastError?.message ?? "unknown error"}`,
    );
  }

  /**
   * Single-shot connect: creates transport + client and calls client.connect().
   * For stdio this is the only path; for HTTP/SSE it's called from connectWithReadiness.
   */
  private async connectOnce(): Promise<void> {
    const transportType = (this.server as any).transport ?? "stdio";

    const client = new Client({
      name: `openclaw-mcp-${this.serverId}`,
      version: "1.0.0",
    });

    if (transportType === "sse") {
      const url = new URL((this.server as any).url);
      const headers = coerceHeaders((this.server as any).headers);
      const requestInit = headers ? ({ headers } as RequestInit) : undefined;
      // SSE transport uses EventSource for receive + POST for send.
      this.transport = new SSEClientTransport(url, {
        requestInit,
        eventSourceInit: headers ? ({ headers } as any) : undefined,
      });
    } else if (transportType === "http") {
      const url = new URL((this.server as any).url);
      const headers = coerceHeaders((this.server as any).headers);
      const requestInit = headers ? ({ headers } as RequestInit) : undefined;
      this.transport = new StreamableHTTPClientTransport(url, {
        requestInit,
      });
    } else {
      const env = (this.server as any).env as Record<string, string> | undefined;
      const mergedEnv = env ? { ...getDefaultEnvironment(), ...env } : undefined;
      const requestedStderr = (this.server as any).stderr;
      const stderr = requestedStderr === "inherit" ? "pipe" : (requestedStderr ?? "pipe");
      this.transport = new StdioClientTransport({
        command: (this.server as any).command,
        args: (this.server as any).args,
        cwd: (this.server as any).cwd,
        env: mergedEnv,
        stderr,
      });
      const stderrStream = this.transport.stderr;
      if (stderrStream) {
        stderrStream.on("data", () => {});
      }
    }

    this.client = client;
    await client.connect(this.transport);
  }

  /** Tear down transport + client so we can retry from scratch. */
  private async resetTransport(): Promise<void> {
    try {
      await this.transport?.close();
    } catch {
      // ignore
    }
    this.transport = null;
    this.client = null;
  }

  async listTools(signal?: AbortSignal): Promise<McpRemoteToolDef[]> {
    await this.connect();
    if (!this.client) {
      throw new Error("MCP client missing");
    }
    const res = await this.client.listTools(undefined, { signal });
    return (res.tools ?? []) as unknown as McpRemoteToolDef[];
  }

  async callTool(params: {
    toolName: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<McpCallResult> {
    await this.connect();
    if (!this.client) {
      throw new Error("MCP client missing");
    }
    const res = await this.client.callTool(
      {
        name: params.toolName,
        arguments: params.args,
      },
      undefined,
      { signal: params.signal },
    );
    return res as unknown as McpCallResult;
  }

  async close(): Promise<void> {
    try {
      await this.transport?.close();
    } catch {
      // ignore
    }
    this.transport = null;
    this.client = null;
    this.connectPromise = null;
  }
}

type AgentMcpState = {
  /** Hash of the effective mcpServers config for this agent. */
  configHash: string;
  servers: McpServersConfig;
  connections: Map<string, McpConnection>;
  toolsPromise: Promise<AnyAgentTool[]> | null;
};

const agentStates = new Map<string, AgentMcpState>();

function ensureAgentState(agentId: string, servers: McpServersConfig): AgentMcpState {
  const id = agentId.trim().toLowerCase() || "main";
  const configHash = stableHash(servers);

  const existing = agentStates.get(id);
  if (existing && existing.configHash === configHash) {
    return existing;
  }

  // Config changed: close existing connections and replace.
  if (existing) {
    void Promise.all(Array.from(existing.connections.values()).map((c) => c.close())).catch(() => {
      // ignore
    });
  }

  const state: AgentMcpState = {
    configHash,
    servers,
    connections: new Map(),
    toolsPromise: null,
  };
  agentStates.set(id, state);
  return state;
}

function getOrCreateConnection(state: AgentMcpState, serverId: string): McpConnection {
  const existing = state.connections.get(serverId);
  if (existing) {
    return existing;
  }
  const server = state.servers[serverId];
  if (!server) {
    throw new Error(`Unknown MCP server: ${serverId}`);
  }
  const conn = new McpConnection({ serverId, server });
  state.connections.set(serverId, conn);
  return conn;
}

function buildMcpPiTool(params: {
  agentId: string;
  serverId: string;
  serverLabel?: string;
  tool: McpRemoteToolDef;
  connection: McpConnection;
  serverConfig?: McpServerConfig;
}): AnyAgentTool {
  const rawName = mcpPiToolName(params.serverId, params.tool.name);
  const normalizedName = normalizeToolName(rawName);
  const labelPrefix = params.serverLabel?.trim() || params.serverId;
  const label = `mcp:${labelPrefix}:${params.tool.name}`;

  // The Pi Agent runtime expects TypeBox-style JSON schema objects.
  // MCP servers return JSON Schema; this is compatible enough for our tool
  // validation + provider schema normalization pipeline.
  let parameters = (params.tool.inputSchema ?? { type: "object" }) as any;

  // Phase #2: Enhance parameter descriptions
  if (parameters.properties && typeof parameters.properties === "object") {
    const enhanced: Record<string, unknown> = {};
    for (const [paramName, paramDef] of Object.entries(parameters.properties)) {
      if (paramDef && typeof paramDef === "object") {
        enhanced[paramName] = enhanceParameterDescription(
          paramDef as Record<string, unknown>,
          paramName,
        );
      }
    }
    parameters = { ...parameters, properties: enhanced };
  }

  // Build enhanced description with server context and auth hints
  const enhancedDescription = params.serverConfig
    ? buildEnhancedDescription(
        params.tool.name,
        params.tool.description,
        params.serverId,
        params.serverLabel,
        params.serverConfig,
      )
    : (params.tool.description ?? `MCP tool: ${params.tool.name}`);

  const execute: AnyAgentTool["execute"] = async (toolCallId, toolParams, signal) => {
    const result = await params.connection.callTool({
      toolName: params.tool.name,
      args: (toolParams ?? {}) as Record<string, unknown>,
      signal,
    });

    const blocks = Array.isArray(result.content) ? result.content : [];

    if (result.isError) {
      const text = blocks
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      // Phase #2: Enhanced error message with more context
      const errorMsg =
        text || `MCP tool failed: ${params.serverLabel || params.serverId}/${params.tool.name}`;
      throw new Error(errorMsg);
    }

    const content = blocks.map((b) => stringifyToolResultContent(b));

    return {
      content,
      details: {
        toolCallId,
        serverId: params.serverId,
        serverLabel: params.serverLabel,
        tool: params.tool.name,
        result,
      },
    } satisfies AgentToolResult<unknown>;
  };

  return {
    name: normalizedName,
    label,
    description: enhancedDescription,
    parameters,
    execute,
  } as AnyAgentTool;
}

export async function resolveMcpToolsForAgent(params: {
  config?: OpenClawConfig;
  agentId: string;
  abortSignal?: AbortSignal;
}): Promise<AnyAgentTool[]> {
  const servers = resolveEffectiveMcpServers({ config: params.config, agentId: params.agentId });
  const enabledServerIds = Object.entries(servers)
    .filter(([, cfg]) => isMcpServerEnabled(cfg))
    .map(([id]) => id);

  if (enabledServerIds.length === 0) {
    return [];
  }

  const state = ensureAgentState(params.agentId, servers);

  if (state.toolsPromise) {
    return state.toolsPromise;
  }

  state.toolsPromise = (async () => {
    // Launch all server connections in parallel — each server's readiness
    // check (retry/backoff for HTTP/SSE) runs concurrently, then we join
    // all results. This avoids sequential startup delays when multiple
    // remote servers need to become ready.
    const serverResults = await Promise.allSettled(
      enabledServerIds.map(async (serverId) => {
        const server = servers[serverId];
        if (!server || !isMcpServerEnabled(server)) {
          return [];
        }

        const conn = getOrCreateConnection(state, serverId);
        const remoteTools = await conn.listTools(params.abortSignal);

        logDebug(
          `[mcp] Loaded ${remoteTools.length} tools from MCP server "${serverId}" (${(server as any).transport ?? "stdio"})`,
        );

        const serverTools: AnyAgentTool[] = [];
        for (const tool of remoteTools) {
          if (!tool?.name?.trim()) {
            continue;
          }
          serverTools.push(
            buildMcpPiTool({
              agentId: params.agentId,
              serverId,
              serverLabel: (server as any).label,
              tool,
              connection: conn,
              serverConfig: server,
            }),
          );
        }
        return serverTools;
      }),
    );

    // Collect tools from successful connections, log failures.
    const tools: AnyAgentTool[] = [];
    for (let i = 0; i < serverResults.length; i++) {
      const result = serverResults[i];
      if (result.status === "fulfilled") {
        tools.push(...result.value);
      } else {
        const serverId = enabledServerIds[i];
        const message =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        logWarn(`[mcp] Failed to load MCP server "${serverId}": ${message}`);
        logDebug(result.reason instanceof Error && result.reason.stack ? result.reason.stack : "");
      }
    }

    // Ensure stable ordering for deterministic tool lists.
    tools.sort((a, b) => a.name.localeCompare(b.name));

    // If no tools could be loaded, don't keep a cached promise forever.
    if (tools.length === 0) {
      logWarn(`[mcp] No MCP tools available for agent "${params.agentId}"`);
      state.toolsPromise = null;
    }

    return tools;
  })();

  return state.toolsPromise;
}

export async function shutdownAllMcpServers(): Promise<void> {
  const states = Array.from(agentStates.values());
  agentStates.clear();
  await Promise.all(
    states.flatMap((state) => Array.from(state.connections.values()).map((conn) => conn.close())),
  );
}

export const __testing = {
  mcpPiToolName,
  normalizeToolComponent,
  stringifyToolResultContent,
  stableStringify,
  stableHash,
  buildMcpPiTool,
  McpConnection,
  agentStates,
  ensureAgentState,
  getOrCreateConnection,
  detectAuthRequired,
  getTransportHint,
  buildEnhancedDescription,
  enhanceParameterDescription,
  resolveReadinessConfig,
  DEFAULT_READINESS,
};
