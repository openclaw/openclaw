import type { Command } from "commander";
import { channelsStatusCommand } from "../commands/channels.js";
import {
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
} from "../commands/doctor-state-migrations.js";
import { loadConfig, resolveGatewayPort } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runTui } from "../tui/tui.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { runDaemonInstall, runDaemonStart } from "./daemon-cli.js";
import { promptYesNo } from "./prompt.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGatewayReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await callGateway({
        method: "health",
        timeoutMs: Math.min(2_000, Math.max(250, deadline - Date.now())),
      });
      return true;
    } catch {
      await sleep(1_000);
    }
  }
  return false;
}

async function maybePortLegacyState(): Promise<void> {
  const cfg = loadConfig();
  const detected = await detectLegacyStateMigrations({ cfg });
  if (detected.preview.length === 0) {
    defaultRuntime.log("Legacy state check: no migration needed.");
    return;
  }

  defaultRuntime.log("Legacy bot state detected:");
  for (const line of detected.preview) {
    defaultRuntime.log(line);
  }

  let proceed = false;
  if (process.stdin.isTTY) {
    proceed = await promptYesNo("Port legacy bot state now?", true);
  } else {
    defaultRuntime.log("Non-interactive run: skipping migration prompt.");
    defaultRuntime.log("Run `openclaw port-bot --yes` to apply legacy migration.");
    return;
  }

  if (!proceed) {
    defaultRuntime.log("Skipping legacy state migration.");
    return;
  }

  const migrated = await runLegacyStateMigrations({ detected });
  if (migrated.changes.length === 0) {
    defaultRuntime.log("Legacy migration: no changes needed.");
  } else {
    defaultRuntime.log("Legacy migration changes:");
    for (const line of migrated.changes) {
      defaultRuntime.log(`- ${line}`);
    }
  }
  if (migrated.warnings.length > 0) {
    defaultRuntime.error("Legacy migration warnings:");
    for (const line of migrated.warnings) {
      defaultRuntime.error(`- ${line}`);
    }
  }
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  const value = typeof raw === "string" ? Number(raw) : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function registerStartCli(program: Command) {
  program
    .command("start")
    .description("Start gateway service, verify channels, then open TUI")
    .option("--service-only", "Start service + channel checks, but do not open TUI", false)
    .option("--timeout <ms>", "Gateway readiness timeout in ms", "20000")
    .option("--runtime <runtime>", 'Gateway runtime (node|bun), default "node"', "node")
    .option("--port <port>", "Gateway service port override")
    .option("--session <key>", 'TUI session key (default: "main")')
    .option("--deliver", "TUI deliver mode", false)
    .option("--message <text>", "Initial TUI message")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = loadConfig();
        const port = opts.port ? String(opts.port) : String(resolveGatewayPort(cfg));
        const timeoutMs = parsePositiveInt(opts.timeout, 20_000);

        defaultRuntime.log("[0/5] Checking legacy state migration...");
        await maybePortLegacyState();

        defaultRuntime.log("[1/5] Installing/updating gateway service...");
        await runDaemonInstall({
          force: true,
          runtime: String(opts.runtime ?? "node"),
          port,
        });

        defaultRuntime.log("[2/5] Starting gateway service...");
        await runDaemonStart({});

        defaultRuntime.log("[3/5] Waiting for gateway to become ready...");
        const ready = await waitForGatewayReady(timeoutMs);
        if (!ready) {
          throw new Error(
            `Gateway did not become healthy within ${timeoutMs}ms. Run: openclaw gateway status`,
          );
        }

        defaultRuntime.log("[4/5] Channel status...");
        await channelsStatusCommand({ probe: false }, defaultRuntime);

        if (opts.serviceOnly) {
          defaultRuntime.log("Gateway is running in background.");
          return;
        }

        defaultRuntime.log("[5/5] Starting TUI...");
        await runTui({
          session: opts.session as string | undefined,
          deliver: Boolean(opts.deliver),
          message: opts.message as string | undefined,
        });
      });
    });
}
