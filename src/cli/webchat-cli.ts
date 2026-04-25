import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { readBestEffortConfig } from "../config/config.js";
import { resolveGatewayPort } from "../config/paths.js";
import { openUrl, resolveBrowserOpenCommand } from "../infra/browser-open.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";

const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_POLL_MAX_ATTEMPTS = 60; // 30 seconds total

async function probeGatewayHealth(port: number): Promise<boolean> {
  try {
    const url = `http://127.0.0.1:${String(port)}/healthz`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return false;
    }
    const body = await res.text();
    return body.includes("ok");
  } catch {
    return false;
  }
}

async function waitForGatewayReady(port: number): Promise<boolean> {
  for (let i = 0; i < HEALTH_POLL_MAX_ATTEMPTS; i++) {
    const healthy = await probeGatewayHealth(port);
    if (healthy) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

function resolveCliEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Try multiple possible entry points (dist vs source)
  const candidates = [
    path.resolve(here, "../../gemmaclaw.mjs"),
    path.resolve(here, "../../openclaw.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  // Fallback: use process.argv[1] which is the current CLI entry
  return process.argv[1] ?? candidates[0];
}

function spawnGateway(port: number): ChildProcess {
  const entryPath = resolveCliEntryPath();
  const args = [entryPath, "gateway", "run", "--allow-unconfigured", "--port", String(port)];

  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    env: process.env,
  });

  // Pipe gateway output to stderr so it doesn't clutter the main output
  child.stdout?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      process.stderr.write(`${theme.muted(`[gateway] ${text}`)}\n`);
    }
  });
  child.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      process.stderr.write(`${theme.muted(`[gateway] ${text}`)}\n`);
    }
  });

  return child;
}

export function registerWebchatCli(program: Command) {
  program
    .command("chat")
    .description("Open a browser-based chat UI for your Gemma assistant")
    .option("--port <port>", "Gateway port (default: auto-detected from config)")
    .option("--no-open", "Start gateway but do not open the browser automatically")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Starts the gateway and opens the web chat UI in your default browser.")}\n`,
    )
    .action(async (opts) => {
      try {
        const cfg = await readBestEffortConfig().catch(() => undefined);
        const port = opts.port
          ? Number.parseInt(String(opts.port), 10)
          : resolveGatewayPort(cfg, process.env);

        if (Number.isNaN(port) || port <= 0 || port > 65535) {
          defaultRuntime.error(`Invalid port: ${String(opts.port)}`);
          defaultRuntime.exit(1);
        }

        const chatUrl = `http://127.0.0.1:${String(port)}/`;

        // Check if gateway is already running
        const alreadyRunning = await probeGatewayHealth(port);
        let child: ChildProcess | undefined;

        if (alreadyRunning) {
          defaultRuntime.log(`Gateway already running on port ${String(port)}.`);
        } else {
          defaultRuntime.log(`Starting gateway on port ${String(port)}...`);
          child = spawnGateway(port);

          child.on("error", (err) => {
            defaultRuntime.error(`Gateway failed to start: ${err.message}`);
            defaultRuntime.exit(1);
          });

          child.on("exit", (code, signal) => {
            if (signal) {
              defaultRuntime.log(`Gateway stopped (${signal}).`);
            } else if (code !== 0) {
              defaultRuntime.error(`Gateway exited with code ${String(code ?? 1)}.`);
            }
            defaultRuntime.exit(code ?? 1);
          });

          // Wait for gateway to become healthy
          const ready = await waitForGatewayReady(port);
          if (!ready) {
            defaultRuntime.error(
              "Gateway did not become ready within 30 seconds. Check the logs above for errors.",
            );
            child.kill("SIGTERM");
            defaultRuntime.exit(1);
          }

          defaultRuntime.log("Gateway is ready.");
        }

        // Open browser
        if (opts.open !== false) {
          const browserCmd = await resolveBrowserOpenCommand();
          if (browserCmd.argv) {
            defaultRuntime.log(`Opening ${chatUrl} in your browser...`);
            const opened = await openUrl(chatUrl);
            if (!opened) {
              defaultRuntime.log(
                `Could not open browser automatically. Open this URL manually:\n  ${chatUrl}`,
              );
            }
          } else {
            defaultRuntime.log(
              `No browser detected (${browserCmd.reason ?? "unknown"}). Open this URL manually:\n  ${chatUrl}`,
            );
          }
        } else {
          defaultRuntime.log(`Chat UI available at: ${chatUrl}`);
        }

        // Keep running
        if (child) {
          defaultRuntime.log(`\n${theme.muted("Press Ctrl+C to stop the gateway and exit.")}`);

          // Forward signals to the child
          const cleanup = (signal: NodeJS.Signals) => {
            child?.kill(signal);
          };
          process.on("SIGINT", () => cleanup("SIGINT"));
          process.on("SIGTERM", () => cleanup("SIGTERM"));

          // Wait for child to exit
          await new Promise<void>((resolve) => {
            child.on("exit", () => resolve());
          });
        } else {
          defaultRuntime.log(`\nGateway is running independently. Chat UI: ${chatUrl}`);
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
