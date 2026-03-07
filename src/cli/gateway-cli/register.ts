import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { gatewayStatusCommand } from "../../commands/gateway-status.js";
import { formatHealthChannelLines, type HealthSummary } from "../../commands/health.js";
import { loadConfig } from "../../config/config.js";
import { discoverGatewayBeacons } from "../../infra/bonjour-discovery.js";
import type { CostUsageSummary } from "../../infra/session-cost-usage.js";
import { resolveWideAreaDiscoveryDomain } from "../../infra/widearea-dns.js";
import { defaultRuntime } from "../../runtime.js";
import { styleHealthChannelLine } from "../../terminal/health-style.js";
import { formatDocsLink } from "../../terminal/links.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { resolveHomeDir } from "../../utils.js";
import { formatTokenCount, formatUsd } from "../../utils/usage-format.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { inheritOptionFromParent } from "../command-options.js";
import { addGatewayServiceCommands } from "../daemon-cli.js";
import { formatHelpExamples } from "../help-format.js";
import { withProgress } from "../progress.js";
import { callGatewayCli, gatewayCallOpts } from "./call.js";
import type { GatewayDiscoverOpts } from "./discover.js";
import {
  dedupeBeacons,
  parseDiscoverTimeoutMs,
  pickBeaconHost,
  pickGatewayPort,
  renderBeaconLines,
} from "./discover.js";
import { addGatewayRunCommand } from "./run.js";

function runGatewayCommand(action: () => Promise<void>, label?: string) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    const message = String(err);
    defaultRuntime.error(label ? `${label}: ${message}` : message);
    defaultRuntime.exit(1);
  });
}

function parseDaysOption(raw: unknown, fallback = 30): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.floor(parsed));
    }
  }
  return fallback;
}

function resolveGatewayRpcOptions<T extends { token?: string; password?: string }>(
  opts: T,
  command?: Command,
): T {
  const parentToken = inheritOptionFromParent<string>(command, "token");
  const parentPassword = inheritOptionFromParent<string>(command, "password");
  return {
    ...opts,
    token: opts.token ?? parentToken,
    password: opts.password ?? parentPassword,
  };
}

function renderCostUsageSummary(summary: CostUsageSummary, days: number, rich: boolean): string[] {
  const totalCost = formatUsd(summary.totals.totalCost) ?? "$0.00";
  const totalTokens = formatTokenCount(summary.totals.totalTokens) ?? "0";
  const lines = [
    colorize(rich, theme.heading, `Usage cost (${days} days)`),
    `${colorize(rich, theme.muted, "Total:")} ${totalCost} · ${totalTokens} tokens`,
  ];

  if (summary.totals.missingCostEntries > 0) {
    lines.push(
      `${colorize(rich, theme.muted, "Missing entries:")} ${summary.totals.missingCostEntries}`,
    );
  }

  const latest = summary.daily.at(-1);
  if (latest) {
    const latestCost = formatUsd(latest.totalCost) ?? "$0.00";
    const latestTokens = formatTokenCount(latest.totalTokens) ?? "0";
    lines.push(
      `${colorize(rich, theme.muted, "Latest day:")} ${latest.date} · ${latestCost} · ${latestTokens} tokens`,
    );
  }

  return lines;
}

export function registerGatewayCli(program: Command) {
  const gateway = addGatewayRunCommand(
    program
      .command("gateway")
      .description("Run, inspect, and query the WebSocket Gateway")
      .addHelpText(
        "after",
        () =>
          `\n${theme.heading("Examples:")}\n${formatHelpExamples([
            ["openclaw gateway run", "Run the gateway in the foreground."],
            ["openclaw gateway status", "Show service status and probe reachability."],
            ["openclaw gateway discover", "Find local and wide-area gateway beacons."],
            ["openclaw gateway call health", "Call a gateway RPC method directly."],
          ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`,
      ),
  );

  addGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
  );

  addGatewayServiceCommands(gateway, {
    statusDescription: "Show gateway service status + probe the Gateway",
  });

  gatewayCallOpts(
    gateway
      .command("call")
      .description("Call a Gateway method")
      .argument("<method>", "Method name (health/status/system-presence/cron.*)")
      .option("--params <json>", "JSON object string for params", "{}")
      .action(async (method, opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const params = JSON.parse(String(opts.params ?? "{}"));
          const result = await callGatewayCli(method, rpcOpts, params);
          if (rpcOpts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const rich = isRich();
          defaultRuntime.log(
            `${colorize(rich, theme.heading, "Gateway call")}: ${colorize(rich, theme.muted, String(method))}`,
          );
          defaultRuntime.log(JSON.stringify(result, null, 2));
        }, "Gateway call failed");
      }),
  );

  gatewayCallOpts(
    gateway
      .command("usage-cost")
      .description("Fetch usage cost summary from session logs")
      .option("--days <days>", "Number of days to include", "30")
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const days = parseDaysOption(opts.days);
          const result = await callGatewayCli("usage.cost", rpcOpts, { days });
          if (rpcOpts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const rich = isRich();
          const summary = result as CostUsageSummary;
          for (const line of renderCostUsageSummary(summary, days, rich)) {
            defaultRuntime.log(line);
          }
        }, "Gateway usage cost failed");
      }),
  );

  gatewayCallOpts(
    gateway
      .command("health")
      .description("Fetch Gateway health")
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const result = await callGatewayCli("health", rpcOpts);
          if (rpcOpts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const rich = isRich();
          const obj: Record<string, unknown> = result && typeof result === "object" ? result : {};
          const durationMs = typeof obj.durationMs === "number" ? obj.durationMs : null;
          defaultRuntime.log(colorize(rich, theme.heading, "Gateway Health"));
          defaultRuntime.log(
            `${colorize(rich, theme.success, "OK")}${durationMs != null ? ` (${durationMs}ms)` : ""}`,
          );
          if (obj.channels && typeof obj.channels === "object") {
            for (const line of formatHealthChannelLines(obj as HealthSummary)) {
              defaultRuntime.log(styleHealthChannelLine(line, rich));
            }
          }
        });
      }),
  );

  gateway
    .command("probe")
    .description("Show gateway reachability + discovery + health + status summary (local + remote)")
    .option("--url <url>", "Explicit Gateway WebSocket URL (still probes localhost)")
    .option("--ssh <target>", "SSH target for remote gateway tunnel (user@host or user@host:port)")
    .option("--ssh-identity <path>", "SSH identity file path")
    .option("--ssh-auto", "Try to derive an SSH target from Bonjour discovery", false)
    .option("--token <token>", "Gateway token (applies to all probes)")
    .option("--password <password>", "Gateway password (applies to all probes)")
    .option("--timeout <ms>", "Overall probe budget in ms", "3000")
    .option("--json", "Output JSON", false)
    .action(async (opts, command) => {
      await runGatewayCommand(async () => {
        const rpcOpts = resolveGatewayRpcOptions(opts, command);
        await gatewayStatusCommand(rpcOpts, defaultRuntime);
      });
    });

  gateway
    .command("discover")
    .description("Discover gateways via Bonjour (local + wide-area if configured)")
    .option("--timeout <ms>", "Per-command timeout in ms", "2000")
    .option("--json", "Output JSON", false)
    .action(async (opts: GatewayDiscoverOpts) => {
      await runGatewayCommand(async () => {
        const cfg = loadConfig();
        const wideAreaDomain = resolveWideAreaDiscoveryDomain({
          configDomain: cfg.discovery?.wideArea?.domain,
        });
        const timeoutMs = parseDiscoverTimeoutMs(opts.timeout, 2000);
        const domains = ["local.", ...(wideAreaDomain ? [wideAreaDomain] : [])];
        const beacons = await withProgress(
          {
            label: "Scanning for gateways…",
            indeterminate: true,
            enabled: opts.json !== true,
            delayMs: 0,
          },
          async () => await discoverGatewayBeacons({ timeoutMs, wideAreaDomain }),
        );

        const deduped = dedupeBeacons(beacons).toSorted((a, b) =>
          String(a.displayName || a.instanceName).localeCompare(
            String(b.displayName || b.instanceName),
          ),
        );

        if (opts.json) {
          const enriched = deduped.map((b) => {
            const host = pickBeaconHost(b);
            const port = pickGatewayPort(b);
            return { ...b, wsUrl: host ? `ws://${host}:${port}` : null };
          });
          defaultRuntime.log(
            JSON.stringify(
              {
                timeoutMs,
                domains,
                count: enriched.length,
                beacons: enriched,
              },
              null,
              2,
            ),
          );
          return;
        }

        const rich = isRich();
        defaultRuntime.log(colorize(rich, theme.heading, "Gateway Discovery"));
        defaultRuntime.log(
          colorize(
            rich,
            theme.muted,
            `Found ${deduped.length} gateway(s) · domains: ${domains.join(", ")}`,
          ),
        );
        if (deduped.length === 0) {
          return;
        }

        for (const beacon of deduped) {
          for (const line of renderBeaconLines(beacon, rich)) {
            defaultRuntime.log(line);
          }
        }
      }, "gateway discover failed");
    });

  gateway
    .command("decisions")
    .description("Tail contextual-activation decision logs in real-time")
    .option("-n, --lines <count>", "Number of initial lines to show", "20")
    .option("--json", "Output raw JSONL (default: human-readable)", false)
    .option("--clean [days]", "Delete log files older than N days (default: 7)")
    .option("--tz <timezone>", "IANA timezone for display (e.g. Asia/Shanghai), default: UTC")
    .action(
      async (opts: { lines?: string; json?: boolean; clean?: string | true; tz?: string }) => {
        const home = resolveHomeDir();
        if (!home) {
          defaultRuntime.error("Cannot resolve home directory");
          defaultRuntime.exit(1);
          return;
        }
        const logDir = path.join(home, ".openclaw", "logs", "contextual-activation");
        if (!fs.existsSync(logDir)) {
          defaultRuntime.error(
            `No contextual-activation logs found at ${logDir}\nEnsure contextualActivation is configured in group settings.`,
          );
          defaultRuntime.exit(1);
          return;
        }

        // --clean: remove old log files
        if (opts.clean != null) {
          const days =
            opts.clean === true ? 7 : Math.max(0, Number.parseInt(String(opts.clean), 10) || 7);
          const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
          const files = fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
          let removed = 0;
          let totalBytes = 0;
          for (const file of files) {
            const fp = path.join(logDir, file);
            const stat = fs.statSync(fp);
            if (stat.mtimeMs < cutoff) {
              totalBytes += stat.size;
              fs.unlinkSync(fp);
              removed++;
            }
          }
          const sizeStr =
            totalBytes > 1024 * 1024
              ? `${(totalBytes / 1024 / 1024).toFixed(1)} MB`
              : `${(totalBytes / 1024).toFixed(1)} KB`;
          defaultRuntime.log(
            removed > 0
              ? `Removed ${removed} log file(s) older than ${days} day(s) (${sizeStr} freed)`
              : `No log files older than ${days} day(s)`,
          );
          return;
        }

        const rich = isRich();
        const displayTz = opts.tz || undefined;
        const lines = Math.max(1, Number.parseInt(String(opts.lines ?? "20"), 10) || 20);

        if (opts.json) {
          // Raw JSONL tail
          const tail = spawn("tail", ["-F", "-n", String(lines), "--glob=*.jsonl"], {
            cwd: logDir,
            stdio: "inherit",
            shell: true,
          });
          tail.on("error", (err) => {
            // Fallback: find files manually
            defaultRuntime.error(`tail failed: ${err.message}`);
            defaultRuntime.exit(1);
          });
          process.on("SIGINT", () => {
            tail.kill();
            process.exit(0);
          });
          return new Promise<void>(() => {});
        }

        // Human-readable mode: tail all JSONL files and format
        defaultRuntime.log(
          colorize(rich, theme.heading, "Contextual Activation Decision Logs") +
            "  " +
            colorize(rich, theme.muted, `(${logDir})`),
        );
        defaultRuntime.log(colorize(rich, theme.muted, "Press Ctrl+C to stop.\n"));

        const tail = spawn(
          "bash",
          [
            "-c",
            `find ${JSON.stringify(logDir)} -name '*.jsonl' | xargs tail -F -n ${lines} 2>/dev/null`,
          ],
          { stdio: ["ignore", "pipe", "ignore"] },
        );

        const decisionColors: Record<string, (s: string) => string> = {
          join: (s: string) => colorize(rich, theme.success, s),
          stay: (s: string) => colorize(rich, theme.info, s),
          skip: (s: string) => colorize(rich, theme.muted, s),
          disengage: (s: string) => colorize(rich, theme.warn, s),
        };

        let buffer = "";
        tail.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            // Skip tail file headers like "==> ... <=="
            if (line.startsWith("==>") || line.trim() === "") {
              continue;
            }
            try {
              const entry = JSON.parse(line);
              let time = "??:??:??";
              if (entry.t) {
                if (displayTz) {
                  try {
                    const d = new Date(entry.t);
                    const parts = new Intl.DateTimeFormat("en-GB", {
                      timeZone: displayTz,
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                      hour12: false,
                    }).formatToParts(d);
                    time = parts
                      .filter((p) => p.type !== "literal" || p.value === ":")
                      .map((p) => p.value)
                      .join("");
                  } catch {
                    time = entry.t.slice(11, 19);
                  }
                } else {
                  time = entry.t.slice(11, 19);
                }
              }
              const mode = entry.mode === "engaged" ? "ENG" : "PEEK";
              const dec = (entry.decision ?? "?").toUpperCase();
              const colorFn = decisionColors[entry.decision] ?? ((s: string) => s);
              const model = entry.model ?? "?";
              const ms = entry.ms != null ? `${entry.ms}ms` : "";
              const msgId = entry.msgId ? `#${entry.msgId}` : "";

              // Build reply hint
              let replyHint = "";
              if (entry.replyId || entry.replySender) {
                const idPart = entry.replyId ? `#${entry.replyId}` : "";
                const senderPart = entry.replySender ?? "";
                const bodyPart = entry.replyBody
                  ? `"${entry.replyBody.slice(0, 40)}${entry.replyBody.length > 40 ? "…" : ""}"`
                  : "";
                let raw = "";
                if (idPart && senderPart && bodyPart) {
                  raw = ` ↩${idPart}[${senderPart}: ${bodyPart}]`;
                } else if (idPart && senderPart) {
                  raw = ` ↩${idPart}[${senderPart}]`;
                } else if (senderPart && bodyPart) {
                  raw = ` ↩[${senderPart}: ${bodyPart}]`;
                } else if (idPart) {
                  raw = ` ↩${idPart}`;
                }
                replyHint = colorize(rich, theme.warn, raw);
              }

              const sender = entry.sender ? ` [${entry.sender}]` : "";
              const body = entry.body
                ? ` "${entry.body.slice(0, 60)}${entry.body.length > 60 ? "…" : ""}"`
                : "";
              const reason = entry.reason ?? "";
              defaultRuntime.log(
                `${colorize(rich, theme.muted, time)} ${mode} ${colorFn(dec.padEnd(10))} ${colorize(rich, theme.muted, ms.padEnd(7))} ${model}  ${msgId}${replyHint}${sender}${body}`,
              );
              if (reason) {
                const teal = (s: string) => chalk.hex("#5BC0BE")(s);
                defaultRuntime.log(
                  `  ${colorize(rich, theme.muted, "→")} ${colorize(rich, teal, reason)}`,
                );
              }
            } catch {
              // Not JSON — print as-is (e.g. tail headers)
              defaultRuntime.log(line);
            }
          }
        });

        process.on("SIGINT", () => {
          tail.kill();
          process.exit(0);
        });
        return new Promise<void>(() => {});
      },
    );
}
