#!/usr/bin/env bun
/**
 * affiliate-check CLI
 * Thin client that talks to the persistent daemon server.
 * If no server is running, starts one automatically.
 *
 * Usage:
 *   affiliate-check search <query>       Search programs
 *   affiliate-check top [--sort trending|new|top]  Top programs
 *   affiliate-check info <name>          Program details
 *   affiliate-check compare <a> <b> [c]  Compare programs
 *   affiliate-check status               Server status
 *   affiliate-check stop                 Stop server
 *   affiliate-check help                 Show help
 */

import { existsSync } from "fs";
import { resolve, dirname } from "path";

const STATE_FILE = "/tmp/affiliate-check.json";
const STARTUP_TIMEOUT = 5000; // 5 seconds

interface ServerState {
  port: number;
  pid: number;
  token: string;
  started: string;
}

function readState(): ServerState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const content = require("fs").readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthCheck(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer(): Promise<number> {
  // Check existing server
  const state = readState();
  if (state && isProcessAlive(state.pid)) {
    const healthy = await healthCheck(state.port);
    if (healthy) return state.port;
  }

  // Start new server
  const serverPath = resolve(dirname(process.argv[1] || __filename), "server.ts");

  // Check if running from compiled binary or source
  const isCompiled = !process.argv[1]?.endsWith(".ts");
  const toolsDir = dirname(isCompiled ? process.execPath : process.argv[1] || __filename);
  const serverScript = isCompiled
    ? resolve(toolsDir, "..", "src", "server.ts")
    : resolve(toolsDir, "server.ts");

  const proc = Bun.spawn(["bun", "run", serverScript], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Wait for server to be ready
  const start = Date.now();
  while (Date.now() - start < STARTUP_TIMEOUT) {
    const newState = readState();
    if (newState && isProcessAlive(newState.pid)) {
      const healthy = await healthCheck(newState.port);
      if (healthy) return newState.port;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error("Failed to start affiliate-check server. Is Bun installed?");
}

async function request(port: number, path: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(10000),
  });
  return response.text();
}

function printHelp() {
  console.log(`
  ${"\x1b[1m"}affiliate-check${"\x1b[0m"} — Live affiliate program data from list.affitor.com

  ${"\x1b[1m"}USAGE${"\x1b[0m"}
    affiliate-check search <query>              Search programs by name/keyword
    affiliate-check search --recurring          Filter by recurring commission
    affiliate-check search --tags ai,video      Filter by tags
    affiliate-check search --min-cookie 30      Filter by minimum cookie days
    affiliate-check top                         Top programs by stars
    affiliate-check top --sort trending         Top by trending
    affiliate-check info <name>                 Detailed info on a program
    affiliate-check compare <a> <b> [c...]      Side-by-side comparison
    affiliate-check status                      Server status + cache info
    affiliate-check stop                        Stop the background server
    affiliate-check help                        Show this help

  ${"\x1b[1m"}ENVIRONMENT${"\x1b[0m"}
    AFFITOR_API_KEY    API key from list.affitor.com (optional)
                       Without key: free tier (max 5 results)
                       Get one: list.affitor.com/settings → API Keys (free)

  ${"\x1b[1m"}EXAMPLES${"\x1b[0m"}
    affiliate-check search "AI video"
    affiliate-check search --recurring --tags ai
    affiliate-check compare heygen synthesia
    affiliate-check top --sort new
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    printHelp();
    return;
  }

  const command = args[0];

  try {
    const port = await ensureServer();

    switch (command) {
      case "search": {
        const params = new URLSearchParams();

        // Parse flags and positional query
        const positional: string[] = [];
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--recurring") {
            params.set("reward_type", "cps_recurring");
          } else if (args[i] === "--tags" && args[i + 1]) {
            params.set("tags", args[++i]);
          } else if (args[i] === "--min-cookie" && args[i + 1]) {
            params.set("min_cookie_days", args[++i]);
          } else if (args[i] === "--sort" && args[i + 1]) {
            params.set("sort", args[++i]);
          } else if (args[i] === "--limit" && args[i + 1]) {
            params.set("limit", args[++i]);
          } else if (!args[i].startsWith("--")) {
            positional.push(args[i]);
          }
        }

        if (positional.length > 0) {
          params.set("q", positional.join(" "));
        }

        const output = await request(port, `/search?${params.toString()}`);
        console.log(output);
        break;
      }

      case "top": {
        const params = new URLSearchParams();
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--sort" && args[i + 1]) {
            params.set("sort", args[++i]);
          } else if (args[i] === "--limit" && args[i + 1]) {
            params.set("limit", args[++i]);
          }
        }
        const output = await request(port, `/top?${params.toString()}`);
        console.log(output);
        break;
      }

      case "info": {
        const name = args.slice(1).join(" ");
        if (!name) {
          console.log("\x1b[31m  Error: Usage: affiliate-check info <program-name>\x1b[0m");
          process.exit(1);
        }
        const output = await request(port, `/info?name=${encodeURIComponent(name)}`);
        console.log(output);
        break;
      }

      case "compare": {
        const names = args.slice(1);
        if (names.length < 2) {
          console.log(
            "\x1b[31m  Error: Usage: affiliate-check compare <program1> <program2>\x1b[0m",
          );
          process.exit(1);
        }
        const output = await request(port, `/compare?names=${encodeURIComponent(names.join(","))}`);
        console.log(output);
        break;
      }

      case "status": {
        const output = await request(port, "/status");
        console.log(output);
        break;
      }

      case "stop": {
        const output = await request(port, "/stop");
        console.log(output);
        break;
      }

      default: {
        console.log(`\x1b[31m  Unknown command: ${command}\x1b[0m`);
        printHelp();
        process.exit(1);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m  Error: ${msg}\x1b[0m`);
    process.exit(1);
  }
}

main();
