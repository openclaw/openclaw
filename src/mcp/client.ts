/**
 * MCP client — manages MCP server lifecycle and tool discovery.
 *
 * Handles spawning stdio-based MCP servers and connecting to SSE-based
 * servers, performing the MCP handshake, discovering tools, and proxying
 * tool calls from the OpenClaw agent to the MCP server.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { defaultRuntime } from "../runtime.js";
import type {
  McpServerConfig,
  McpServerConnection,
  McpToolCallResult,
  McpToolDefinition,
} from "./types.js";

/** Namespaced logger for MCP subsystem. */
const log = {
  info: (...args: unknown[]) => defaultRuntime.log("[mcp]", ...args),
  error: (...args: unknown[]) => defaultRuntime.error("[mcp]", ...args),
  debug: (...args: unknown[]) => {
    if (process.env.OPENCLAW_MCP_DEBUG === "1") {
      defaultRuntime.log("[mcp:debug]", ...args);
    }
  },
};

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const INITIALIZE_TIMEOUT_MS = 15_000;
const JSONRPC_VERSION = "2.0";

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

type JsonRpcRequest = {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type JsonRpcNotification = {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: Record<string, unknown>;
};

function createRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: randomUUID(),
    method,
    ...(params ? { params } : {}),
  };
}

function createNotification(
  method: string,
  params?: Record<string, unknown>,
): JsonRpcNotification {
  return {
    jsonrpc: JSONRPC_VERSION,
    method,
    ...(params ? { params } : {}),
  };
}

// ---------------------------------------------------------------------------
// Environment variable resolution
// ---------------------------------------------------------------------------

/** Resolve ${VAR} references in env values from process.env. */
function resolveEnvVars(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      return process.env[varName] ?? "";
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// StdioTransport — communicates with an MCP server via stdin/stdout
// ---------------------------------------------------------------------------

class StdioTransport extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = "";
  private pendingRequests = new Map<
    string | number,
    {
      resolve: (value: JsonRpcResponse) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
  ) {
    super();
  }

  async start(): Promise<void> {
    // Only pass a minimal safe set of env vars plus explicitly configured ones.
    // This prevents leaking secrets (API keys, tokens) to MCP server processes.
    const safeBaseEnv: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      SHELL: process.env.SHELL,
      LANG: process.env.LANG,
      TERM: process.env.TERM,
      NODE_ENV: process.env.NODE_ENV,
      TMPDIR: process.env.TMPDIR,
    };
    const mergedEnv = { ...safeBaseEnv, ...this.env };

    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: mergedEnv,
      // Prevent the MCP server from inheriting signals meant for the parent.
      detached: false,
    });

    this.process.stdout?.setEncoding("utf-8");
    this.process.stderr?.setEncoding("utf-8");

    this.process.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.processBuffer();
    });

    this.process.stderr?.on("data", (chunk: string) => {
      // MCP servers often emit debug/log info on stderr — route it to our logger.
      for (const line of chunk.split("\n").filter(Boolean)) {
        log.debug(`[mcp:stderr] ${line}`);
      }
    });

    this.process.on("error", (err) => {
      log.error(`MCP server process error: ${err.message}`);
      this.rejectAllPending(err);
      this.emit("error", err);
    });

    this.process.on("exit", (code, signal) => {
      log.info(`MCP server process exited (code=${code}, signal=${signal})`);
      this.rejectAllPending(new Error(`MCP server exited (code=${code})`));
      this.emit("close", code);
    });
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.process?.stdin?.writable) {
      throw new Error("MCP server stdin not writable");
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error(`MCP request timed out: ${request.method} (id=${request.id})`));
      }, DEFAULT_TOOL_TIMEOUT_MS);

      this.pendingRequests.set(request.id, { resolve, reject, timer });

      const payload = JSON.stringify(request) + "\n";
      this.process!.stdin!.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(request.id);
          reject(err);
        }
      });
    });
  }

  sendNotification(notification: JsonRpcNotification): void {
    if (!this.process?.stdin?.writable) {
      return;
    }
    const payload = JSON.stringify(notification) + "\n";
    this.process.stdin.write(payload);
  }

  async stop(): Promise<void> {
    this.rejectAllPending(new Error("MCP transport stopped"));
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      // Give it a second to exit gracefully, then force-kill.
      await new Promise<void>((resolve) => {
        const forceTimer = setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill("SIGKILL");
          }
          resolve();
        }, 3000);

        this.process?.on("exit", () => {
          clearTimeout(forceTimer);
          resolve();
        });
      });
    }
    this.process = null;
  }

  private processBuffer(): void {
    // MCP uses newline-delimited JSON.
    const lines = this.buffer.split("\n");
    // Keep the last (potentially incomplete) chunk.
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcNotification;
        if ("id" in msg && msg.id != null) {
          // It's a response.
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(msg.id);
            pending.resolve(msg as JsonRpcResponse);
          }
        } else {
          // Server-initiated notification — emit for logging.
          this.emit("notification", msg);
        }
      } catch {
        log.debug(`[mcp] Non-JSON line from server: ${trimmed.slice(0, 200)}`);
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pendingRequests.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// SseTransport — connects to an MCP server via SSE (Server-Sent Events)
// ---------------------------------------------------------------------------

class SseTransport extends EventEmitter {
  private abortController: AbortController | null = null;
  private messagesUrl: string | null = null;
  private pendingRequests = new Map<
    string | number,
    {
      resolve: (value: JsonRpcResponse) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {
    super();
  }

  async start(): Promise<void> {
    this.abortController = new AbortController();

    // SSE transport: connect to the endpoint URL to receive events.
    const sseUrl = this.url.endsWith("/sse") ? this.url : `${this.url}/sse`;
    const response = await fetch(sseUrl, {
      headers: { ...this.headers, Accept: "text/event-stream" },
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
    }

    // The SSE stream sends an "endpoint" event first with the messages URL.
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("SSE response has no body");
    }

    // Read the SSE stream in the background.
    void this.readSseStream(reader);

    // Wait for the endpoint event with a timeout.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for SSE endpoint event"));
      }, INITIALIZE_TIMEOUT_MS);

      const handler = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once("endpoint", handler);
    });
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.messagesUrl) {
      throw new Error("SSE transport not connected (missing messages URL)");
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error(`MCP request timed out: ${request.method} (id=${request.id})`));
      }, DEFAULT_TOOL_TIMEOUT_MS);

      this.pendingRequests.set(request.id, { resolve, reject, timer });

      void fetch(this.messagesUrl!, {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: this.abortController?.signal,
      }).catch((err) => {
        clearTimeout(timer);
        this.pendingRequests.delete(request.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  sendNotification(notification: JsonRpcNotification): void {
    if (!this.messagesUrl) {
      return;
    }
    void fetch(this.messagesUrl, {
      method: "POST",
      headers: {
        ...this.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(notification),
      signal: this.abortController?.signal,
    }).catch((err) => {
      log.debug(`[mcp:sse] Failed to send notification: ${String(err)}`);
    });
  }

  async stop(): Promise<void> {
    this.rejectAllPending(new Error("SSE transport stopped"));
    this.abortController?.abort();
    this.abortController = null;
    this.messagesUrl = null;
  }

  private async readSseStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          this.parseSseEvent(event);
        }
      }
    } catch (err) {
      if (this.abortController && !this.abortController.signal.aborted) {
        log.error(`SSE stream error: ${String(err)}`);
        this.emit("error", err);
      }
    } finally {
      this.emit("close");
    }
  }

  private parseSseEvent(raw: string): void {
    let eventType = "message";
    let data = "";

    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }

    if (eventType === "endpoint" && data) {
      // The server sends the messages URL as the data.
      // It may be relative to the base URL.
      try {
        const resolved = new URL(data, this.url);
        const baseOrigin = new URL(this.url).origin;
        // Prevent SSRF: reject endpoint redirects to a different origin.
        // A malicious SSE server could redirect requests (with auth headers) elsewhere.
        if (resolved.origin !== baseOrigin) {
          log.error(
            `SSE endpoint redirected to different origin: ${resolved.origin} (expected ${baseOrigin})`,
          );
          this.emit("error", new Error("SSE endpoint origin mismatch"));
          return;
        }
        this.messagesUrl = resolved.href;
      } catch {
        this.messagesUrl = data;
      }
      this.emit("endpoint");
      return;
    }

    if (eventType === "message" && data) {
      try {
        const msg = JSON.parse(data) as JsonRpcResponse | JsonRpcNotification;
        if ("id" in msg && msg.id != null) {
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(msg.id);
            pending.resolve(msg as JsonRpcResponse);
          }
        } else {
          this.emit("notification", msg);
        }
      } catch {
        log.debug(`[mcp:sse] Failed to parse event data: ${data.slice(0, 200)}`);
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pendingRequests.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

type McpTransportInstance = {
  start: () => Promise<void>;
  send: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  sendNotification: (notification: JsonRpcNotification) => void;
  stop: () => Promise<void>;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};

// ---------------------------------------------------------------------------
// connectMcpServer — full handshake + tool discovery
// ---------------------------------------------------------------------------

export async function connectMcpServer(
  name: string,
  config: McpServerConfig,
): Promise<McpServerConnection> {
  const transport = createTransport(name, config);
  let status: McpServerConnection["status"] = "connecting";
  let tools: McpToolDefinition[] = [];
  let errorMessage: string | undefined;

  const timeoutMs = config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  try {
    await transport.start();

    // Step 1: Initialize handshake.
    const initRequest = createRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "openclaw",
        version: "1.0.0",
      },
    });

    const initResponse = await Promise.race([
      transport.send(initRequest),
      rejectAfter(INITIALIZE_TIMEOUT_MS, "MCP initialize timed out"),
    ]);

    if (initResponse.error) {
      throw new Error(`MCP initialize failed: ${initResponse.error.message}`);
    }

    // Step 2: Send initialized notification.
    transport.sendNotification(createNotification("notifications/initialized"));

    // Step 3: List available tools.
    const toolsRequest = createRequest("tools/list");
    const toolsResponse = await Promise.race([
      transport.send(toolsRequest),
      rejectAfter(INITIALIZE_TIMEOUT_MS, "MCP tools/list timed out"),
    ]);

    if (toolsResponse.error) {
      throw new Error(`MCP tools/list failed: ${toolsResponse.error.message}`);
    }

    const toolsResult = toolsResponse.result as { tools?: McpToolDefinition[] } | undefined;
    tools = toolsResult?.tools ?? [];
    status = "connected";

    log.info(`MCP server "${name}" connected — ${tools.length} tool(s) available`);
    for (const tool of tools) {
      log.debug(`  → ${tool.name}: ${tool.description?.slice(0, 80) ?? "(no description)"}`);
    }
  } catch (err) {
    status = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
    log.error(`MCP server "${name}" failed to connect: ${errorMessage}`);
  }

  const connection: McpServerConnection = {
    name,
    config,
    tools,
    status,
    error: errorMessage,

    callTool: async (
      toolName: string,
      args: Record<string, unknown>,
      callTimeoutMs?: number,
    ): Promise<McpToolCallResult> => {
      if (status !== "connected") {
        return {
          content: [{ type: "text", text: `MCP server "${name}" is not connected.` }],
          isError: true,
        };
      }

      const effectiveTimeout = callTimeoutMs ?? timeoutMs;

      try {
        const request = createRequest("tools/call", { name: toolName, arguments: args });
        const response = await Promise.race([
          transport.send(request),
          rejectAfter(effectiveTimeout, `MCP tool call "${toolName}" timed out (${effectiveTimeout}ms)`),
        ]);

        if (response.error) {
          return {
            content: [
              {
                type: "text",
                text: `MCP tool error: ${response.error.message} (code: ${response.error.code})`,
              },
            ],
            isError: true,
          };
        }

        const result = response.result as McpToolCallResult | undefined;
        return result ?? { content: [{ type: "text", text: "(empty result)" }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },

    ping: async (): Promise<boolean> => {
      if (status !== "connected") {
        return false;
      }
      try {
        const request = createRequest("ping");
        await Promise.race([
          transport.send(request),
          rejectAfter(5000, "MCP ping timed out"),
        ]);
        return true;
      } catch {
        return false;
      }
    },

    reconnect: async (): Promise<void> => {
      log.info(`Reconnecting MCP server "${name}"...`);
      try {
        await transport.stop();
      } catch {
        // Ignore errors during disconnect — we're reconnecting anyway.
      }

      try {
        const refreshed = await connectMcpServer(name, config);
        // Copy refreshed state back into this connection object.
        connection.tools = refreshed.tools;
        connection.status = refreshed.status;
        connection.error = refreshed.error;
        // Wire the new transport's methods through.
        connection.callTool = refreshed.callTool;
        connection.ping = refreshed.ping;
        connection.disconnect = refreshed.disconnect;
        connection.reconnect = refreshed.reconnect;
        status = refreshed.status;
        log.info(`MCP server "${name}" reconnected — status: ${refreshed.status}`);
      } catch (err) {
        status = "error";
        connection.status = "error";
        connection.error = err instanceof Error ? err.message : String(err);
        log.error(`MCP server "${name}" reconnect failed: ${connection.error}`);
      }
    },

    disconnect: async () => {
      status = "closed";
      await transport.stop();
      log.info(`MCP server "${name}" disconnected`);
    },
  };

  return connection;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTransport(name: string, config: McpServerConfig): McpTransportInstance {
  const transport = config.transport ?? "stdio";

  if (transport === "sse") {
    if (!config.url) {
      throw new Error(`MCP server "${name}": SSE transport requires a "url" field`);
    }
    return new SseTransport(config.url, config.headers ?? {});
  }

  // Default: stdio
  if (!config.command) {
    throw new Error(`MCP server "${name}": stdio transport requires a "command" field`);
  }
  const resolvedEnv = resolveEnvVars(config.env);
  return new StdioTransport(config.command, config.args ?? [], resolvedEnv);
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}
