import type { Command } from "commander";
import type { CostUsageSummary } from "../../infra/session-cost-usage.js";
import type { GatewayDiscoverOpts } from "./discover.js";
import { gatewayStatusCommand } from "../../commands/gateway-status.js";
import { formatHealthChannelLines, type HealthSummary } from "../../commands/health.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { discoverGatewayBeacons } from "../../infra/bonjour-discovery.js";
import {
  readGatewayIncidentEntries,
  readGatewayIncidentState,
  recordGatewayRecoverAttempt,
  resolveGatewayIncidentsPath,
} from "../../infra/gateway-incidents.js";
import { writeRestartSentinel } from "../../infra/restart-sentinel.js";
import { resolveWideAreaDiscoveryDomain } from "../../infra/widearea-dns.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { formatTokenCount, formatUsd } from "../../utils/usage-format.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import {
  runDaemonInstall,
  runDaemonRestart,
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
  runDaemonUninstall,
} from "../daemon-cli.js";
import { withProgress } from "../progress.js";
import { callGatewayCli, gatewayCallOpts } from "./call.js";
import {
  dedupeBeacons,
  parseDiscoverTimeoutMs,
  pickBeaconHost,
  pickGatewayPort,
  renderBeaconLines,
} from "./discover.js";
import { addGatewayRunCommand } from "./run.js";

function styleHealthChannelLine(line: string, rich: boolean): string {
  if (!rich) {
    return line;
  }
  const colon = line.indexOf(":");
  if (colon === -1) {
    return line;
  }

  const label = line.slice(0, colon + 1);
  const detail = line.slice(colon + 1).trimStart();
  const normalized = detail.toLowerCase();

  const applyPrefix = (prefix: string, color: (value: string) => string) =>
    `${label} ${color(detail.slice(0, prefix.length))}${detail.slice(prefix.length)}`;

  if (normalized.startsWith("failed")) {
    return applyPrefix("failed", theme.error);
  }
  if (normalized.startsWith("ok")) {
    return applyPrefix("ok", theme.success);
  }
  if (normalized.startsWith("linked")) {
    return applyPrefix("linked", theme.success);
  }
  if (normalized.startsWith("configured")) {
    return applyPrefix("configured", theme.success);
  }
  if (normalized.startsWith("not linked")) {
    return applyPrefix("not linked", theme.warn);
  }
  if (normalized.startsWith("not configured")) {
    return applyPrefix("not configured", theme.muted);
  }
  if (normalized.startsWith("unknown")) {
    return applyPrefix("unknown", theme.warn);
  }

  return line;
}

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
      .description("Run the WebSocket Gateway")
      .addHelpText(
        "after",
        () =>
          `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`,
      ),
  );

  addGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
  );

  gateway
    .command("status")
    .description("Show gateway service status + probe the Gateway")
    .option("--url <url>", "Gateway WebSocket URL (defaults to config/remote/local)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--no-probe", "Skip RPC probe")
    .option("--deep", "Scan system-level services", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runDaemonStatus({
        rpc: opts,
        probe: Boolean(opts.probe),
        deep: Boolean(opts.deep),
        json: Boolean(opts.json),
      });
    });

  gateway
    .command("install")
    .description("Install the Gateway service (launchd/systemd/schtasks)")
    .option("--port <port>", "Gateway port")
    .option("--runtime <runtime>", "Daemon runtime (node|bun). Default: node")
    .option("--token <token>", "Gateway token (token auth)")
    .option("--force", "Reinstall/overwrite if already installed", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runDaemonInstall(opts);
    });

  gateway
    .command("uninstall")
    .description("Uninstall the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runDaemonUninstall(opts);
    });

  gateway
    .command("start")
    .description("Start the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runDaemonStart(opts);
    });

  gateway
    .command("stop")
    .description("Stop the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runDaemonStop(opts);
    });

  gateway
    .command("restart")
    .description("Restart the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runDaemonRestart(opts);
    });

  gateway
    .command("incidents")
    .description("Show recent gateway incidents (signals, crashes, recoveries)")
    .option("--limit <n>", "Max entries", "50")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runGatewayCommand(async () => {
        const limitRaw = typeof opts.limit === "string" ? opts.limit : "50";
        const limit = Math.max(1, Math.min(5000, Number.parseInt(limitRaw, 10) || 50));
        const filePath = resolveGatewayIncidentsPath(process.env);
        const [state, entries] = await Promise.all([
          readGatewayIncidentState(process.env),
          readGatewayIncidentEntries(filePath, { limit }),
        ]);

        if (opts.json) {
          defaultRuntime.log(
            JSON.stringify(
              {
                filePath,
                state,
                entries,
              },
              null,
              2,
            ),
          );
          return;
        }

        const rich = isRich();
        defaultRuntime.log(colorize(rich, theme.heading, "Gateway Incidents"));
        defaultRuntime.log(colorize(rich, theme.muted, `log: ${filePath}`));
        defaultRuntime.log(
          colorize(
            rich,
            theme.muted,
            `restartCount=${state.restartCount}${state.lastRestartReason ? ` · lastRestartReason=${state.lastRestartReason}` : ""}${state.lastCrashAtMs ? ` · lastCrash=${new Date(state.lastCrashAtMs).toISOString()}` : ""}`,
          ),
        );

        if (entries.length === 0) {
          defaultRuntime.log("(no incidents recorded)");
          return;
        }

        for (const entry of entries) {
          const ts = new Date(entry.ts).toISOString();
          const kind = entry.kind;
          const detail =
            kind === "signal"
              ? `signal=${entry.signal ?? "?"}`
              : kind === "recover"
                ? `status=${entry.status ?? "?"}${entry.detail ? ` · ${entry.detail}` : ""}`
                : kind === "crash"
                  ? `${entry.errorName ?? "Error"}${entry.errorMessage ? `: ${entry.errorMessage}` : ""}`
                  : `pid=${entry.pid ?? "?"}${entry.restartReason ? ` · reason=${entry.restartReason}` : ""}`;
          defaultRuntime.log(`${ts}  ${kind.padEnd(7)}  ${detail}`);
        }
      }, "gateway incidents failed");
    });

  gatewayCallOpts(
    gateway
      .command("recover")
      .description("Attempt to recover a stuck gateway (best effort; avoids reinstall by default)")
      .option("--force", "Attempt recovery even if gateway is reachable", false)
      .option("--cooldown-ms <ms>", "Minimum time between recovery attempts (anti-loop)", "60000")
      .action(async (opts) => {
        await runGatewayCommand(async () => {
          const now = Date.now();
          const cooldownMsRaw = typeof opts.cooldownMs === "string" ? opts.cooldownMs : "60000";
          const cooldownMs = Math.max(0, Number.parseInt(cooldownMsRaw, 10) || 60_000);
          const force = Boolean(opts.force);
          const sessionKey = resolveMainSessionKeyFromConfig();
          const writeSentinel = async (status: "ok" | "error", message: string) => {
            try {
              await writeRestartSentinel({
                kind: "recover",
                status,
                ts: Date.now(),
                sessionKey,
                message,
              });
            } catch {
              // ignore
            }
          };

          const state = await readGatewayIncidentState(process.env);
          const lastAttempt = state.lastRecoverAttemptAtMs ?? 0;
          if (!force && lastAttempt > 0 && now - lastAttempt < cooldownMs) {
            const remainingMs = cooldownMs - (now - lastAttempt);
            const message = `recovery suppressed (cooldown active; retry in ${Math.ceil(remainingMs / 1000)}s or pass --force)`;
            await recordGatewayRecoverAttempt({ status: "ok", detail: message, env: process.env });
            await writeSentinel("ok", message);
            if (opts.json) {
              defaultRuntime.log(JSON.stringify({ ok: true, skipped: true, message }, null, 2));
            } else {
              defaultRuntime.log(message);
            }
            return;
          }

          const probeOk = await callGatewayCli("health", opts).then(
            () => true,
            () => false,
          );

          if (probeOk && !force) {
            const message = "gateway is reachable; no recovery needed";
            await recordGatewayRecoverAttempt({ status: "ok", detail: message, env: process.env });
            await writeSentinel("ok", message);
            if (opts.json) {
              defaultRuntime.log(JSON.stringify({ ok: true, skipped: true, message }, null, 2));
            } else {
              defaultRuntime.log(message);
            }
            return;
          }

          const service = resolveGatewayService();
          const loaded = await service.isLoaded({ env: process.env }).catch(() => false);
          const action = loaded ? "restart" : "start";

          if (!loaded) {
            const message = `gateway service ${service.notLoadedText}; recovery cannot proceed (install required)`;
            await recordGatewayRecoverAttempt({
              status: "error",
              detail: message,
              env: process.env,
            });
            await writeSentinel("error", message);
            if (opts.json) {
              defaultRuntime.log(JSON.stringify({ ok: false, message }, null, 2));
            } else {
              defaultRuntime.error(message);
            }
            defaultRuntime.exit(1);
            return;
          }

          try {
            await service.restart({ env: process.env, stdout: process.stdout });
          } catch (err) {
            const message = `gateway ${action} failed: ${String(err)}`;
            await recordGatewayRecoverAttempt({
              status: "error",
              detail: message,
              env: process.env,
            });
            await writeSentinel("error", message);
            if (opts.json) {
              defaultRuntime.log(JSON.stringify({ ok: false, message }, null, 2));
            } else {
              defaultRuntime.error(message);
            }
            defaultRuntime.exit(1);
            return;
          }

          // Give the service a moment to come up.
          await new Promise((r) => setTimeout(r, 1500));

          const recovered = await callGatewayCli("health", opts).then(
            () => true,
            () => false,
          );

          if (recovered) {
            const message = "gateway recovery succeeded";
            await recordGatewayRecoverAttempt({ status: "ok", detail: message, env: process.env });
            await writeSentinel("ok", message);
            if (opts.json) {
              defaultRuntime.log(JSON.stringify({ ok: true, message }, null, 2));
            } else {
              defaultRuntime.log(message);
            }
            return;
          }

          const message = "gateway still unreachable after recovery attempt";
          await recordGatewayRecoverAttempt({ status: "error", detail: message, env: process.env });
          await writeSentinel("error", message);
          if (opts.json) {
            defaultRuntime.log(JSON.stringify({ ok: false, message }, null, 2));
          } else {
            defaultRuntime.error(message);
          }
          defaultRuntime.exit(1);
        }, "gateway recover failed");
      }),
  );

  gatewayCallOpts(
    gateway
      .command("call")
      .description("Call a Gateway method")
      .argument("<method>", "Method name (health/status/system-presence/cron.*)")
      .option("--params <json>", "JSON object string for params", "{}")
      .action(async (method, opts) => {
        await runGatewayCommand(async () => {
          const params = JSON.parse(String(opts.params ?? "{}"));
          const result = await callGatewayCli(method, opts, params);
          if (opts.json) {
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
      .action(async (opts) => {
        await runGatewayCommand(async () => {
          const days = parseDaysOption(opts.days);
          const result = await callGatewayCli("usage.cost", opts, { days });
          if (opts.json) {
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
      .action(async (opts) => {
        await runGatewayCommand(async () => {
          const result = await callGatewayCli("health", opts);
          if (opts.json) {
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
    .action(async (opts) => {
      await runGatewayCommand(async () => {
        await gatewayStatusCommand(opts, defaultRuntime);
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
}
