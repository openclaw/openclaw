import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Command } from "commander";
import { STATE_DIR } from "../config/paths.js";
import { parseSshTarget } from "../infra/ssh-tunnel.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";

const DEFAULT_PORT = 18789;
const PID_FILE = "tunnel.pid.json";

type TunnelState = {
  target: string;
  localPort: number;
  remotePort: number;
  pid: number;
  startedAt: string;
};

function tunnelPidPath(): string {
  return path.join(STATE_DIR, PID_FILE);
}

function readTunnelState(): TunnelState | null {
  try {
    const raw = fs.readFileSync(tunnelPidPath(), "utf-8");
    return JSON.parse(raw) as TunnelState;
  } catch {
    return null;
  }
}

function writeTunnelState(state: TunnelState): void {
  fs.writeFileSync(tunnelPidPath(), JSON.stringify(state, null, 2), "utf-8");
}

function deleteTunnelState(): void {
  try {
    fs.unlinkSync(tunnelPidPath());
  } catch {
    // ignore if already gone
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isPortBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE");
    });
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function killPid(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  // Wait up to 1.5s for clean exit, then SIGKILL
  await new Promise<void>((resolve) => {
    const deadline = setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
      resolve();
    }, 1500);
    const poll = setInterval(() => {
      if (!isPidAlive(pid)) {
        clearTimeout(deadline);
        clearInterval(poll);
        resolve();
      }
    }, 100);
  });
}

export function registerTunnelCli(program: Command) {
  const rich = isRich();

  const tunnel = program
    .command("tunnel")
    .description("Manage persistent SSH port-forward tunnels to a remote gateway")
    .addHelpText(
      "after",
      () =>
        `\n${formatHelpExamples([
          {
            command: "openclaw tunnel up user@myserver",
            description: "Start a tunnel to a remote gateway on the default port (18789).",
          },
          {
            command: "openclaw tunnel up user@myserver --port 18789",
            description: "Start a tunnel specifying the port explicitly.",
          },
          {
            command: "openclaw tunnel up user@myserver:2222",
            description: "Start a tunnel using a non-standard SSH port.",
          },
          {
            command: "openclaw tunnel down",
            description: "Stop the running SSH tunnel.",
          },
          {
            command: "openclaw tunnel status",
            description: "Show tunnel status and port binding.",
          },
        ])}\n${theme.muted("Docs:")} ${formatDocsLink("/cli/tunnel", "docs.openclaw.ai/cli/tunnel")}\n`,
    );

  // ── tunnel up ───────────────────────────────────────────────────────────────
  tunnel
    .command("up")
    .description("Start a background SSH tunnel to a remote gateway")
    .argument("<target>", "SSH target: user@host or user@host:sshport")
    .option(
      "--port <port>",
      `Gateway port to forward (local and remote), default ${DEFAULT_PORT}`,
      String(DEFAULT_PORT),
    )
    .option("--identity <path>", "SSH identity file path (optional)")
    .action(async (target: string, opts: { port: string; identity?: string }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const port = parseInt(opts.port, 10);
        if (!Number.isFinite(port) || port <= 0 || port > 65535) {
          throw new Error(`Invalid port: ${opts.port}`);
        }

        const parsed = parseSshTarget(target);
        if (!parsed) {
          throw new Error(
            `Invalid SSH target: "${target}"\nExpected format: user@host or user@host:sshport`,
          );
        }

        // Check for existing tunnel
        const existing = readTunnelState();
        if (existing && isPidAlive(existing.pid)) {
          throw new Error(
            `A tunnel is already running (PID ${existing.pid} → ${existing.target}:${existing.remotePort}).\nRun ${colorize(rich, theme.command, "openclaw tunnel down")} first.`,
          );
        }
        // Stale PID file — clean it up silently
        if (existing) {
          deleteTunnelState();
        }

        const userHost = parsed.user ? `${parsed.user}@${parsed.host}` : parsed.host;
        const args = [
          "-N",
          "-L",
          `${port}:127.0.0.1:${port}`,
          "-p",
          String(parsed.port),
          "-o",
          "ExitOnForwardFailure=yes",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "UpdateHostKeys=yes",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "ServerAliveInterval=15",
          "-o",
          "ServerAliveCountMax=3",
        ];
        if (opts.identity?.trim()) {
          args.push("-i", opts.identity.trim());
        }
        args.push("--", userHost);

        defaultRuntime.log(
          `${colorize(rich, theme.muted, "→")} Starting SSH tunnel to ${colorize(rich, theme.command, target)} on port ${colorize(rich, theme.command, String(port))}…`,
        );

        // Spawn detached so the tunnel outlives this CLI process
        const child = spawn("/usr/bin/ssh", args, {
          detached: true,
          stdio: "ignore",
        });
        child.unref();

        if (typeof child.pid !== "number") {
          throw new Error("Failed to spawn SSH process (no PID assigned).");
        }

        // Wait for the port to become bound (up to 8s)
        const deadline = Date.now() + 8000;
        let bound = false;
        while (Date.now() < deadline) {
          if (!isPidAlive(child.pid)) {
            throw new Error(
              `SSH process exited immediately. Check that:\n` +
                `  • ${target} is reachable and in your known_hosts\n` +
                `  • SSH key auth is configured (no password prompts)\n` +
                `  • Port ${port} is open on the remote host`,
            );
          }
          if (await isPortBound(port)) {
            bound = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 150));
        }

        if (!bound) {
          // Kill it — something went wrong silently
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {
            // ignore
          }
          throw new Error(
            `Tunnel did not bind to localhost:${port} within 8s.\n` +
              `Check SSH connectivity and that port ${port} is forwarded on the remote host.`,
          );
        }

        const state: TunnelState = {
          target,
          localPort: port,
          remotePort: port,
          pid: child.pid,
          startedAt: new Date().toISOString(),
        };
        writeTunnelState(state);

        defaultRuntime.log(
          `${colorize(rich, theme.success ?? theme.command, "✓")} Tunnel active: ` +
            `${colorize(rich, theme.command, `localhost:${port}`)} → ` +
            `${colorize(rich, theme.command, target)} ` +
            `${colorize(rich, theme.muted, `(PID ${child.pid})`)}`,
        );
        defaultRuntime.log(
          colorize(
            rich,
            theme.muted,
            `Run "openclaw tunnel down" to stop or "openclaw tunnel status" to check.`,
          ),
        );
      });
    });

  // ── tunnel down ─────────────────────────────────────────────────────────────
  tunnel
    .command("down")
    .description("Stop the running SSH tunnel")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const state = readTunnelState();

        if (!state) {
          defaultRuntime.log(colorize(rich, theme.muted, "No tunnel is currently running."));
          return;
        }

        if (!isPidAlive(state.pid)) {
          deleteTunnelState();
          defaultRuntime.log(
            colorize(rich, theme.muted, `Tunnel was already stopped (stale PID ${state.pid} cleaned up).`),
          );
          return;
        }

        defaultRuntime.log(
          `${colorize(rich, theme.muted, "→")} Stopping tunnel (PID ${state.pid})…`,
        );
        await killPid(state.pid);
        deleteTunnelState();

        defaultRuntime.log(
          `${colorize(rich, theme.success ?? theme.command, "✓")} Tunnel stopped.`,
        );
      });
    });

  // ── tunnel status ────────────────────────────────────────────────────────────
  tunnel
    .command("status")
    .description("Show tunnel status and port binding")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const state = readTunnelState();

        if (!state) {
          defaultRuntime.log(colorize(rich, theme.muted, "No tunnel is running."));
          defaultRuntime.log(
            colorize(rich, theme.muted, `Run "openclaw tunnel up <target>" to start one.`),
          );
          return;
        }

        const alive = isPidAlive(state.pid);
        const portActive = alive ? await isPortBound(state.localPort) : false;

        const statusLabel = alive && portActive
          ? colorize(rich, theme.success ?? theme.command, "active")
          : alive
            ? colorize(rich, theme.muted, "running (port not bound yet?)")
            : colorize(rich, theme.error ?? theme.muted, "dead (stale PID file)");

        defaultRuntime.log(`${colorize(rich, theme.heading, "Tunnel status")}`);
        defaultRuntime.log(`  ${colorize(rich, theme.muted, "Target:")}     ${state.target}`);
        defaultRuntime.log(`  ${colorize(rich, theme.muted, "Local port:")} localhost:${state.localPort}`);
        defaultRuntime.log(`  ${colorize(rich, theme.muted, "PID:")}        ${state.pid}`);
        defaultRuntime.log(`  ${colorize(rich, theme.muted, "Started:")}    ${state.startedAt}`);
        defaultRuntime.log(`  ${colorize(rich, theme.muted, "Status:")}     ${statusLabel}`);

        if (!alive) {
          defaultRuntime.log("");
          defaultRuntime.log(
            colorize(rich, theme.muted, `Cleaning up stale PID file…`),
          );
          deleteTunnelState();
          defaultRuntime.log(
            colorize(rich, theme.muted, `Run "openclaw tunnel up ${state.target}" to restart.`),
          );
        }
      });
    });
}
