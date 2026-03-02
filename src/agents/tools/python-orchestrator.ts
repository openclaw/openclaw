import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { IncomingMessage } from "node:http";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";

const PythonOrchestratorSchema = Type.Object({
  code: Type.String({
    description: "Python code to execute. Can use openclaw_tools module to call other tools.",
  }),
  timeout_seconds: Type.Optional(
    Type.Number({
      default: 60,
      description: "Maximum execution time in seconds",
    }),
  ),
});

interface ToolCallRecord {
  tool: string;
  params: unknown;
  result: unknown;
  durationMs: number;
}

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
): Promise<{ port: number; toolCalls: ToolCallRecord[]; stop: () => void }> {
  const toolCalls: ToolCallRecord[] = [];
  let callCount = 0;

  const server = createServer(async (req, res) => {
    // Enable CORS for local requests
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.url === "/call" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const { tool: toolName, params } = JSON.parse(body);

        // Security: Check if tool exists
        const toolDef = availableTools.find((t) => t.name === toolName);
        if (!toolDef) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Tool '${toolName}' not available` }));
          return;
        }

        // Limit check
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
  };
}

async function createPythonScript(
  tempDir: string,
  pythonCode: string,
  bridgePort: number,
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

class ToolError(Exception):
    """Error when calling a tool"""
    pass

async def call_tool(name: str, params: dict) -> dict:
    """Call an OpenClaw tool via the bridge"""
    req = urllib.request.Request(
        f"{BRIDGE_URL}/call",
        data=json.dumps({"tool": name, "params": params}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=300) as response:
            result = json.loads(response.read().decode())
            if "error" in result:
                raise ToolError(result["error"])
            return result
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        try:
            error_data = json.loads(error_body)
            raise ToolError(error_data.get("error", f"HTTP {e.code}"))
        except json.JSONDecodeError:
            raise ToolError(f"HTTP {e.code}: {error_body}")
    except Exception as e:
        raise ToolError(f"Failed to call tool: {e}")

# Convenience wrappers for common tools
from typing import Optional, List, Dict, Any

async def exec_bash(command: str, cwd: Optional[str] = None, timeout: int = 60) -> Dict[str, Any]:
    """Execute a bash command"""
    params: Dict[str, Any] = { "command": command, "timeout": timeout }
    if cwd:
        params["cwd"] = cwd
    return await call_tool("exec", params)

async def read_file(path: str, limit: Optional[int] = None) -> str:
    """Read a file"""
    params: Dict[str, Any] = { "path": path }
    if limit is not None:
        params["limit"] = limit
    result = await call_tool("read", params)
    return result.get("content", "")

async def write_file(path: str, content: str) -> None:
    """Write to a file"""
    await call_tool("write", { "path": path, "content": content })

async def list_files(path: str = ".", recursive: bool = False) -> List[str]:
    """List files in a directory using exec"""
    cmd = f"ls -1 {'-R' if recursive else ''} {path}"
    result = await exec_bash(cmd)
    if result.get("success"):
        stdout = result.get("stdout", "")
        return [f for f in stdout.strip().split("\\n") if f]
    return []

async def search_files(pattern: str, path: str = ".") -> List[str]:
    """Search for files matching a pattern using find"""
    cmd = f"find {path} -name '{pattern}' -type f"
    result = await exec_bash(cmd)
    if result.get("success"):
        stdout = result.get("stdout", "")
        return [f for f in stdout.strip().split("\\n") if f]
    return []

async def glob_files(pattern: str, path: str = ".") -> List[str]:
    """Find files matching a glob pattern"""
    # Use bash glob expansion
    cmd = f"ls -1 {path}/{pattern} 2>/dev/null || echo ''"
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
- await search_files(pattern, path=".") -> List[str]
- await glob_files(pattern, path=".") -> List[str]
- await exec_bash(command, cwd=None, timeout=60) -> dict
- await call_tool(name, params) -> dict

**Example - processing multiple files efficiently:**
\`\`\`python
# List all files
files = await list_files("/path/to/dir", recursive=True)

# Filter and process in batch
results = []
for f in files:
    if f.endswith(".log"):
        content = await read_file(f, limit=50)
        results.append(f"{f}: {len(content)} chars")

print("\\n".join(results))
print(f"\\nTotal files processed: {len(results)}")
\`\`\``,
    parameters: PythonOrchestratorSchema,
    execute: async (_toolCallId, args): Promise<AgentToolResult<unknown>> => {
      const params = args as Record<string, unknown>;
      const userCode = readStringParam(params, "code", { required: true });
      const timeoutSeconds = (params.timeout_seconds as number) ?? 60;

      if (!userCode) {
        return {
          content: [{ type: "text", text: "Error: code parameter is required" }],
          details: { error: "Missing code parameter" },
        };
      }

      const tempDir = await mkdtemp(join(tmpdir(), "openclaw-ptc-"));
      let bridgeServer: { stop: () => void; port: number; toolCalls: ToolCallRecord[] } | null =
        null;

      try {
        // Start the tool bridge server
        bridgeServer = await startToolBridgeServer(
          opts?.availableTools ?? [],
          opts?.maxToolCalls ?? 100,
        );

        // Create the Python script
        const scriptPath = await createPythonScript(tempDir, userCode, bridgeServer.port);

        // Execute Python
        const { stdout, stderr, exitCode } = await new Promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>((resolve, reject) => {
          const pythonProcess = spawn("python3", [scriptPath], {
            cwd: tempDir,
            env: {
              ...process.env,
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

          pythonProcess.on("close", (procExitCode) => {
            resolve({ stdout: output, stderr: errorOutput, exitCode: procExitCode ?? 0 });
          });

          pythonProcess.on("error", (error) => {
            reject(error);
          });

          // Timeout handler
          setTimeout(() => {
            pythonProcess.kill("SIGTERM");
            reject(new Error(`Timeout after ${timeoutSeconds}s`));
          }, timeoutSeconds * 1000);
        });

        // Build result
        const details: Record<string, unknown> = {
          exit_code: exitCode,
          tool_calls_count: bridgeServer.toolCalls.length,
          tool_calls: bridgeServer.toolCalls.map((tc) => ({
            tool: tc.tool,
            duration_ms: tc.durationMs,
          })),
        };

        if (stderr) {
          details.stderr = stderr;
        }

        if (exitCode !== 0) {
          return {
            content: [
              { type: "text", text: `Execution failed (exit ${exitCode}):\n${stderr || stdout}` },
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
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  };
}
