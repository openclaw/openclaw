/**
 * Mock MCP Server for testing.
 *
 * A minimal MCP server that runs as a child process over stdio.
 * Configurable tools, resources, and fault injection for deterministic testing.
 *
 * Usage:
 *   const proc = spawnMockMcpServer({ tools: [...], resources: [...] });
 *   // connect to proc.stdin / proc.stdout via MCP client
 *   // cleanup: proc.kill()
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type MockToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Static response text for this tool */
  response?: string;
};

export type MockResourceDef = {
  uri: string;
  name: string;
  description?: string;
  content: string;
  mimeType?: string;
};

export type MockServerOptions = {
  tools?: MockToolDef[];
  resources?: MockResourceDef[];
  /** Simulate crash after N tool calls */
  crashAfter?: number;
  /** Simulate slow response (ms) */
  latency?: number;
  /** Return this text as a tool result (for injection testing) */
  injectPayload?: string;
};

/**
 * Spawn a mock MCP server as a child process.
 * The server reads its configuration from the MOCK_MCP_CONFIG env var.
 */
export function spawnMockMcpServer(options: MockServerOptions = {}): ChildProcess {
  const configJson = JSON.stringify(options);
  const serverScript = path.join(__dirname, "mock-mcp-server-process.ts");

  const child = spawn("node", ["--import", "tsx", serverScript], {
    env: {
      ...process.env,
      MOCK_MCP_CONFIG: configJson,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  return child;
}
