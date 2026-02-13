/**
 * CLI for the Aether Conductor module.
 *
 * Usage:
 *   openclaw conductor run              — Start the conductor (wraps Claude Code)
 *   openclaw conductor run --command "claude --model opus"
 *   openclaw conductor status           — Show conductor session state
 *   openclaw conductor history          — Show authorization history
 *   openclaw conductor config           — Show current conductor config
 */

import type { ConductorConfig } from "@aether/conductor";
import type { Command } from "commander";
import { createBrowserExecutor } from "../conductor/browser-executor.js";
import { createGatewayForwarder } from "../conductor/gateway-forwarder.js";
import { Conductor } from "../conductor/index.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";

export function registerConductorCli(program: Command) {
  const cmd = program
    .command("conductor")
    .description("Aether Conductor — closed-loop external access authorization for AI agents")
    .addHelpText(
      "after",
      `
${isRich() ? theme.muted("The conductor wraps an AI coding agent and intercepts requests for") : ""}
${isRich() ? theme.muted("external access, routing them through messaging for your approval.") : ""}
`,
    );

  // --- run ---
  cmd
    .command("run")
    .description("Start the conductor, wrapping the specified AI agent command")
    .option("--command <cmd>", "Command to wrap (default: claude)")
    .option("--args <args>", "Arguments for the wrapped command (comma-separated)")
    .option("--analyzer <provider>", "Analyzer provider: gemini, openai, regex (default: gemini)")
    .option("--confidence <threshold>", "Minimum confidence threshold (0-1)", "0.7")
    .option("--channel <channel>", "Messaging channel for auth requests (e.g., whatsapp)")
    .option("--to <target>", "Messaging target (chat/user ID)")
    .option("--auto-approve <patterns>", "URL patterns to auto-approve (comma-separated)")
    .option("--auto-deny <patterns>", "URL patterns to auto-deny (comma-separated)")
    .option("--timeout <ms>", "Authorization timeout in milliseconds", "120000")
    .option("--no-audit", "Disable audit logging")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = loadConfig();
        const conductorConfig = buildConductorConfig(cfg.conductor, opts);

        console.log(theme.info("Aether Conductor starting..."));
        console.log(
          theme.muted(
            `  Command: ${conductorConfig.wrappedCommand} ${(conductorConfig.wrappedArgs ?? []).join(" ")}`,
          ),
        );
        console.log(theme.muted(`  Analyzer: ${conductorConfig.analyzer?.provider ?? "gemini"}`));
        const targets = conductorConfig.auth?.targets ?? [];
        if (targets.length > 0) {
          console.log(
            theme.muted(`  Auth targets: ${targets.map((t) => `${t.channel}:${t.to}`).join(", ")}`),
          );
        } else {
          console.log(
            theme.warn(
              "  No auth targets configured. Use --channel and --to, or set conductor.auth.targets in config.",
            ),
          );
        }
        console.log("");

        // Wire up the conductor with OpenClaw adapters
        const conductor = new Conductor({
          config: conductorConfig,
          forwarder: createGatewayForwarder(conductorConfig.auth ?? { targets: [] }),
          executor: createBrowserExecutor(conductorConfig.browser ?? {}),
        });

        // Log events to console
        conductor.on((event) => {
          switch (event.type) {
            case "started":
              console.log(theme.success(`Conductor online. Child PID: ${event.pid}`));
              break;
            case "request-detected":
              console.log(
                theme.warn(`\n[Conductor] External access detected: ${event.request.summary}`),
              );
              console.log(theme.muted(`  Kind: ${event.request.kind}`));
              if (event.request.url) {
                console.log(theme.muted(`  URL: ${event.request.url}`));
              }
              console.log(theme.info("  Waiting for operator authorization..."));
              break;
            case "authorization-received":
              console.log(
                theme.info(
                  `[Conductor] Authorization received: ${event.auth.decision} (by ${event.auth.resolvedBy ?? "unknown"})`,
                ),
              );
              break;
            case "executing":
              console.log(theme.muted(`[Conductor] Executing browser actions...`));
              break;
            case "injection":
              console.log(
                event.injection.success
                  ? theme.success(`[Conductor] Result injected into agent.`)
                  : theme.error(`[Conductor] Injection failed.`),
              );
              break;
            case "error":
              console.error(theme.error(`[Conductor] Error: ${event.message}`));
              break;
            case "stopped":
              console.log(theme.muted("[Conductor] Stopped."));
              break;
          }
        });

        // Handle SIGINT/SIGTERM gracefully
        const cleanup = () => {
          console.log(theme.muted("\n[Conductor] Shutting down..."));
          conductor.stop();
          process.exit(0);
        };
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);

        await conductor.start();
      });
    });

  // --- status ---
  cmd
    .command("status")
    .description("Show current conductor session state")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        console.log(theme.info("Conductor status:"));
        console.log(theme.muted("  (Run 'openclaw conductor run' to start a session)"));
      });
    });

  // --- history ---
  cmd
    .command("history")
    .description("Show authorization history from the audit log")
    .option("--limit <n>", "Number of entries to show", "20")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const auditPath = path.join(os.homedir(), ".openclaw", "conductor-audit.jsonl");
        if (!fs.existsSync(auditPath)) {
          console.log(theme.muted("No audit history found."));
          return;
        }
        const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean);
        const limit = Number.parseInt(String(opts.limit), 10) || 20;
        const recent = lines.slice(-limit);
        for (const line of recent) {
          try {
            const entry = JSON.parse(line) as {
              event?: string;
              ts?: number;
              [key: string]: unknown;
            };
            const time = entry.ts ? new Date(entry.ts).toISOString() : "?";
            console.log(`${theme.muted(time)} ${entry.event ?? "unknown"}`);
          } catch {
            // skip malformed lines
          }
        }
      });
    });

  // --- config ---
  cmd
    .command("config")
    .description("Show current conductor configuration")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = loadConfig();
        const conductorCfg = cfg.conductor;
        if (!conductorCfg) {
          console.log(theme.muted("No conductor config found in openclaw.json."));
          console.log(
            theme.muted('Add a "conductor" section to ~/.openclaw/openclaw.json to configure.'),
          );
          return;
        }
        console.log(JSON.stringify(conductorCfg, null, 2));
      });
    });
}

// ---------------------------------------------------------------------------
// Config resolution: merge file config with CLI flags
// ---------------------------------------------------------------------------

function buildConductorConfig(
  fileConfig: ConductorConfig | undefined,
  opts: Record<string, unknown>,
): ConductorConfig {
  const base: ConductorConfig = { ...fileConfig };

  if (typeof opts.command === "string" && opts.command.trim()) {
    const parts = opts.command.trim().split(/\s+/);
    base.wrappedCommand = parts[0];
    if (parts.length > 1) {
      base.wrappedArgs = parts.slice(1);
    }
  }

  if (typeof opts.args === "string" && opts.args.trim()) {
    base.wrappedArgs = opts.args.split(",").map((a: string) => a.trim());
  }

  if (typeof opts.analyzer === "string") {
    base.analyzer = {
      ...base.analyzer,
      provider: opts.analyzer as "gemini" | "openai" | "regex",
    };
  }

  if (typeof opts.confidence === "string") {
    const threshold = Number.parseFloat(opts.confidence);
    if (!Number.isNaN(threshold)) {
      base.analyzer = { ...base.analyzer, confidenceThreshold: threshold };
    }
  }

  if (typeof opts.channel === "string" && typeof opts.to === "string") {
    const target = { channel: opts.channel, to: opts.to };
    base.auth = {
      ...base.auth,
      targets: [...(base.auth?.targets ?? []), target],
    };
  }

  if (typeof opts.autoApprove === "string") {
    base.auth = {
      ...base.auth,
      autoApprovePatterns: opts.autoApprove.split(",").map((p: string) => p.trim()),
    };
  }

  if (typeof opts.autoDeny === "string") {
    base.auth = {
      ...base.auth,
      autoDenyPatterns: opts.autoDeny.split(",").map((p: string) => p.trim()),
    };
  }

  if (typeof opts.timeout === "string") {
    const ms = Number.parseInt(opts.timeout, 10);
    if (!Number.isNaN(ms)) {
      base.auth = { ...base.auth, timeoutMs: ms };
    }
  }

  if (opts.audit === false) {
    base.auditLog = false;
  }

  return base;
}
