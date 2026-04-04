import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";

const PythonOrchestratorSchema = Type.Object({
  code: Type.String({
    description: "Python code to execute. Can use openclaw_tools module to call other tools.",
  }),
  timeout_seconds: Type.Optional(
    Type.Number({
      default: 180,
      description: "Maximum execution time in seconds",
    }),
  ),
});

interface ToolCallRecord {
  tool: string;
  params: unknown;
  result: unknown;
  durationMs: number;
  cached?: boolean;
}

// LRU Cache for tool call results with memory limits
interface CacheEntry {
  result: unknown;
  timestamp: number;
  estimatedSize: number; // Estimated size in bytes
}

class ToolCallCache {
  private cache = new Map<string, CacheEntry>();
  private maxEntries: number;
  private ttlMs: number;
  private maxMemoryBytes: number;
  private currentMemoryBytes: number = 0;

  constructor(maxEntries = 200, ttlSeconds = 300, maxMemoryMB = 50) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlSeconds * 1000;
    this.maxMemoryBytes = maxMemoryMB * 1024 * 1024;
  }

  private makeKey(tool: string, params: unknown): string {
    return `${tool}:${JSON.stringify(params)}`;
  }

  private estimateSize(value: unknown): number {
    // Rough size estimation in bytes
    try {
      const json = JSON.stringify(value);
      return json ? json.length : 100;
    } catch {
      return 100; // Default size for non-serializable
    }
  }

  get(tool: string, params: unknown): { result: unknown; cached: boolean } | null {
    const key = this.makeKey(tool, params);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Evict expired entries
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      this.currentMemoryBytes -= entry.estimatedSize;
      return null;
    }

    // LRU: delete and re-insert to move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return { result: entry.result, cached: true };
  }

  set(tool: string, params: unknown, result: unknown): void {
    const key = this.makeKey(tool, params);
    const estimatedSize = this.estimateSize(result);

    // Update existing entry if present (moves to end)
    if (this.cache.has(key)) {
      const oldEntry = this.cache.get(key)!;
      this.currentMemoryBytes -= oldEntry.estimatedSize;
      this.cache.delete(key);
    }

    // Evict LRU entries until we have room
    while (
      this.cache.size >= this.maxEntries ||
      this.currentMemoryBytes + estimatedSize > this.maxMemoryBytes
    ) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      const oldEntry = this.cache.get(oldestKey)!;
      this.cache.delete(oldestKey);
      this.currentMemoryBytes -= oldEntry.estimatedSize;
    }

    this.cache.set(key, { result, timestamp: Date.now(), estimatedSize });
    this.currentMemoryBytes += estimatedSize;
  }

  clear(): void {
    this.cache.clear();
    this.currentMemoryBytes = 0;
  }

  get stats() {
    return {
      size: this.cache.size,
      maxEntries: this.maxEntries,
      ttlSeconds: this.ttlMs / 1000,
      memoryBytes: this.currentMemoryBytes,
      maxMemoryBytes: this.maxMemoryBytes,
      memoryUsagePercent: Math.round((this.currentMemoryBytes / this.maxMemoryBytes) * 100),
    };
  }
}

// RAM-aware concurrency limiter
class ConcurrencyLimiter {
  private running = 0;
  private readonly maxConcurrent: number;
  private readonly queue: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }

  get status() {
    return {
      running: this.running,
      maxConcurrent: this.maxConcurrent,
      queued: this.queue.length,
    };
  }
}

// Calculate max concurrent Python processes based on available RAM
// With 64GB total, keep ~16GB for system + agent overhead (~48GB for Python processes)
// Each Python orchestrator typically uses 50-200MB baseline, assume 256MB max per process
function calculateMaxConcurrent(): number {
  const total = totalmem();
  const cpuCount = cpus().length;
  const reservedBytes = 16 * 1024 * 1024 * 1024; // 16GB reserved

  const availableBytes = total > reservedBytes ? total - reservedBytes : total * 0.5;
  const bytesPerProcess = 256 * 1024 * 1024; // 256MB per process

  const maxByRam = Math.floor(availableBytes / bytesPerProcess);
  const maxByCpu = cpuCount * 4; // 4x CPU count for I/O bound work

  // Take the minimum of RAM-based and CPU-based limits, but ensure at least 2
  return Math.max(2, Math.min(maxByRam, maxByCpu));
}

// Global concurrency limiter instance
const concurrencyLimiter = new ConcurrencyLimiter(calculateMaxConcurrent());

// Global rate limiter for tool bridge calls (across all sessions)
// Prevents abuse via multiple concurrent Python orchestrator sessions
class GlobalRateLimiter {
  private calls: number = 0;
  private windowStart: number = Date.now();
  private readonly maxCallsPerWindow: number;
  private readonly windowMs: number;

  constructor(maxCallsPerMinute: number = 1000) {
    this.maxCallsPerWindow = maxCallsPerMinute;
    this.windowMs = 60 * 1000; // 1 minute window
  }

  private resetIfWindowExpired() {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.calls = 0;
      this.windowStart = now;
    }
  }

  async acquire(): Promise<boolean> {
    this.resetIfWindowExpired();
    if (this.calls >= this.maxCallsPerWindow) {
      return false;
    }
    this.calls++;
    return true;
  }

  get status() {
    this.resetIfWindowExpired();
    return {
      calls: this.calls,
      maxCallsPerWindow: this.maxCallsPerWindow,
      windowMs: this.windowMs,
      remaining: Math.max(0, this.maxCallsPerWindow - this.calls),
    };
  }
}

const globalRateLimiter = new GlobalRateLimiter(1000); // 1000 calls/minute global limit

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function startToolBridgeServer(
  availableTools: AnyAgentTool[],
  maxCalls: number = 100,
  allowedTools?: string[],
  sessionCache?: ToolCallCache,
): Promise<{ port: number; toolCalls: ToolCallRecord[]; stop: () => void; authToken: string }> {
  const toolCalls: ToolCallRecord[] = [];
  let callCount = 0;

  // Generate random auth token for this session
  const authToken = randomBytes(32).toString("hex");

  // Build allowed tools set if specified
  const allowedToolsSet = allowedTools ? new Set(allowedTools) : null;

  const server = createServer(async (req, res) => {
    // Enable CORS for local requests
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.url === "/call" && req.method === "POST") {
      try {
        // Authentication check
        const providedToken = req.headers["x-bridge-token"];
        if (!providedToken || providedToken !== authToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid or missing authentication token" }));
          return;
        }

        const body = await readBody(req);
        const { tool: toolName, params } = JSON.parse(body);

        // Security: Check if tool exists
        const toolDef = availableTools.find((t) => t.name === toolName);
        if (!toolDef) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Tool '${toolName}' not available` }));
          return;
        }

        // Security: Check if tool is in allowed list
        if (allowedToolsSet && !allowedToolsSet.has(toolName)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Tool '${toolName}' not allowed by configuration` }));
          return;
        }

        // Check cache first (before incrementing callCount)
        if (sessionCache) {
          const cached = sessionCache.get(toolName, params);
          if (cached) {
            toolCalls.push({
              tool: toolName,
              params,
              result: cached.result,
              durationMs: 0,
              cached: true,
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(cached.result));
            return;
          }
        }

        // Global rate limit check (across all sessions)
        const rateLimitOk = await globalRateLimiter.acquire();
        if (!rateLimitOk) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Global rate limit exceeded. Try again later." }));
          return;
        }

        // Per-session limit check (only for non-cached calls)
        callCount++;
        if (callCount > maxCalls) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Max tool calls exceeded" }));
          return;
        }

        // Execute tool
        const start = Date.now();
        const result = await toolDef.execute(`bridge-${callCount}`, params);
        const durationMs = Date.now() - start;

        // Cache the result
        if (sessionCache) {
          sessionCache.set(toolName, params, result);
        }

        toolCalls.push({ tool: toolName, params, result, durationMs });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", calls: callCount }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  // Start server on random port
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    toolCalls,
    stop: () => server.close(),
    authToken,
  };
}

async function createPythonScript(
  tempDir: string,
  pythonCode: string,
  bridgePort: number,
  bridgeAuthToken: string,
): Promise<string> {
  const scriptPath = join(tempDir, "orchestrator.py");

  const bootstrapCode = `
import asyncio
import os
import sys
import json
import urllib.request
import urllib.error

# Bridge configuration
BRIDGE_PORT = ${bridgePort}
BRIDGE_URL = f"http://127.0.0.1:{BRIDGE_PORT}"
BRIDGE_TOKEN = "${bridgeAuthToken}"

class ToolError(Exception):
    """Error when calling a tool"""
    pass

async def call_tool(name: str, params: dict) -> dict:
    """Call an OpenClaw tool via the bridge"""
    req = urllib.request.Request(
        f"{BRIDGE_URL}/call",
        data=json.dumps({"tool": name, "params": params}).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Bridge-Token": BRIDGE_TOKEN,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=300) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        try:
            error_data = json.loads(error_body)
            raise ToolError(f"Tool '{name}' failed: {error_data.get('error', error_body)}")
        except json.JSONDecodeError:
            raise ToolError(f"Tool '{name}' failed: {error_body}")
    except Exception as e:
        raise ToolError(f"Tool '{name}' failed: {str(e)}")

# Create convenience functions for common tools
async def read_file(path: str, limit: int = None, offset: int = None) -> str:
    """Read a file's contents"""
    params = {"path": path}
    if limit is not None:
        params["limit"] = limit
    if offset is not None:
        params["offset"] = offset
    result = await call_tool("read", params)
    return result.get("content", "")

async def write_file(path: str, content: str) -> None:
    """Write content to a file"""
    await call_tool("write", {"path": path, "content": content})

async def list_files(path: str = ".", recursive: bool = False) -> list:
    """List files in a directory"""
    result = await call_tool("list", {"path": path, "recursive": recursive})
    return result.get("files", [])

async def search_files(query: str, path: str = ".") -> list:
    """Search for files by name"""
    result = await call_tool("search", {"query": query, "path": path})
    return result.get("files", [])

async def exec_bash(command: str, cwd: str = None) -> dict:
    """Execute a bash command"""
    params = {"command": command}
    if cwd:
        params["cwd"] = cwd
    return await call_tool("bash", params)

async def exec_process(command: str, args: list = None, cwd: str = None, timeout: int = None) -> dict:
    """Execute a process with arguments"""
    params = {"command": command}
    if args:
        params["args"] = args
    if cwd:
        params["cwd"] = cwd
    if timeout:
        params["timeout"] = timeout
    return await call_tool("process", params)

# Glob helper
async def glob_files(pattern: str, path: str = ".") -> list:
    """Find files matching a glob pattern"""
    cmd = f"find {path} -name '{pattern}' -type f 2>/dev/null"
    result = await exec_bash(cmd)
    if result.get("success"):
        stdout = result.get("stdout", "")
        files = [f for f in stdout.strip().split("\\n") if f]
        return files
    return []

# User code wrapper
async def main():
    try:
${pythonCode
  .split("\n")
  .map((line) => "        " + line)
  .join("\n")}
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
`;

  await writeFile(scriptPath, bootstrapCode, "utf-8");
  return scriptPath;
}

export function createPythonOrchestratorTool(opts?: {
  availableTools?: AnyAgentTool[];
  maxToolCalls?: number;
  timeoutSeconds?: number;
  allowedTools?: string[];
}): AnyAgentTool {
  return {
    label: "Python Orchestrator",
    name: "python_orchestrator",
    description: `**PREFERRED TOOL**: Use this tool whenever you need to perform multiple operations (read files, list directories, search, execute commands) or process data programmatically.

**WHEN TO USE:**
- Reading/analyzing more than 2-3 files → Use python_orchestrator
- Searching for files and processing them → Use python_orchestrator
- Any multi-step workflow → Use python_orchestrator
- Batch processing → Use python_orchestrator
- Data transformation or filtering → Use python_orchestrator

**DO NOT** call individual tools (read, list, search) separately when you can batch them with python_orchestrator.

This tool executes Python code with async/await support and provides access to OpenClaw tools via the openclaw_tools module.

Available async functions:
- await read_file(path, limit=None) -> str
- await write_file(path, content) -> None
- await list_files(path=".", recursive=False) -> List[str]
- await search_files(query, path=".") -> List[str]
- await exec_bash(command, cwd=None) -> dict
- await glob_files(pattern, path=".") -> List[str]
- await call_tool(name, params) -> dict (for any OpenClaw tool)

All tool calls are tracked and limited to ${opts?.maxToolCalls ?? 100} per execution for safety.`,
    parameters: PythonOrchestratorSchema,
    execute: async (_toolCallId, args): Promise<AgentToolResult<unknown>> => {
      const params = args as Record<string, unknown>;
      const userCode = readStringParam(params, "code", { required: true });
      const timeoutSeconds = (params.timeout_seconds as number) ?? opts?.timeoutSeconds ?? 180;

      if (!userCode) {
        return {
          content: [{ type: "text", text: "Error: code parameter is required" }],
          details: { error: "Missing code parameter" },
        };
      }

      // Use concurrency limiter to control resource usage
      return concurrencyLimiter.run(async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "openclaw-ptc-"));
        let bridgeServer: {
          stop: () => void;
          port: number;
          toolCalls: ToolCallRecord[];
          authToken: string;
        } | null = null;

        // Create session-scoped cache for tool calls
        const sessionCache = new ToolCallCache(200, 300);

        try {
          // Start the tool bridge server
          bridgeServer = await startToolBridgeServer(
            opts?.availableTools ?? [],
            opts?.maxToolCalls ?? 100,
            opts?.allowedTools,
            sessionCache,
          );

          // Create the Python script
          const scriptPath = await createPythonScript(
            tempDir,
            userCode,
            bridgeServer.port,
            bridgeServer.authToken,
          );

          // Execute Python
          const { stdout, stderr, exitCode } = await new Promise<{
            stdout: string;
            stderr: string;
            exitCode: number;
          }>((resolve, reject) => {
            // Filter environment variables to avoid leaking sensitive credentials
            // Only pass essential variables and explicitly whitelisted ones
            const SAFE_ENV_VARS = new Set([
              "PATH",
              "HOME",
              "USER",
              "LANG",
              "LC_ALL",
              "TZ",
              "NODE_ENV",
              "PYTHONPATH",
              "PYENV_VERSION",
              "VIRTUAL_ENV",
            ]);
            const filteredEnv: Record<string, string> = {};
            for (const [key, value] of Object.entries(process.env)) {
              if (SAFE_ENV_VARS.has(key) || key.startsWith("PY")) {
                filteredEnv[key] = value ?? "";
              }
            }

            const pythonProcess = spawn("python3", [scriptPath], {
              cwd: tempDir,
              env: {
                ...filteredEnv,
                OPENCLAW_BRIDGE_PORT: String(bridgeServer!.port),
                PYTHONUNBUFFERED: "1",
              },
              timeout: timeoutSeconds * 1000,
            });

            let output = "";
            let errorOutput = "";

            pythonProcess.stdout?.on("data", (data) => {
              output += data.toString();
            });

            pythonProcess.stderr?.on("data", (data) => {
              errorOutput += data.toString();
            });

            // Timeout handler - stored to clear on normal completion
            const timeoutHandle = setTimeout(() => {
              pythonProcess.kill("SIGTERM");
              reject(new Error(`Timeout after ${timeoutSeconds}s`));
            }, timeoutSeconds * 1000);

            pythonProcess.on("close", (procExitCode) => {
              clearTimeout(timeoutHandle);
              resolve({ stdout: output, stderr: errorOutput, exitCode: procExitCode ?? 0 });
            });

            pythonProcess.on("error", (error) => {
              clearTimeout(timeoutHandle);
              reject(error);
            });
          });

          // Build result
          const details: Record<string, unknown> = {
            exit_code: exitCode,
            tool_calls_count: bridgeServer.toolCalls.length,
            tool_calls: bridgeServer.toolCalls.map((tc) => ({
              tool: tc.tool,
              duration_ms: tc.durationMs,
              cached: tc.cached ?? false,
            })),
            cache_stats: sessionCache.stats,
          };

          if (stderr) {
            details.stderr = stderr;
          }

          if (exitCode !== 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Execution failed (exit ${exitCode}):\\n${stderr || stdout}`,
                },
              ],
              details,
            };
          }

          return {
            content: [{ type: "text", text: stdout || "(no output)" }],
            details,
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error: ${String(error)}` }],
            details: { error: String(error) },
          };
        } finally {
          // Cleanup
          bridgeServer?.stop();
          try {
            await rm(tempDir, { recursive: true, force: true });
          } catch (err) {
            // Log cleanup failures for debugging (disk space issues, permission problems)
            console.warn(`[python_orchestrator] Temp dir cleanup failed: ${String(err)}`);
          }
        }
      });
    },
  };
}
