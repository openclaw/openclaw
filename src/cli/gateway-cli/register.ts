import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { colorize, isRich, theme } from "../../../packages/terminal-core/src/theme.js";
import type { HealthSummary } from "../../commands/health.js";
import type { CostUsageSummary } from "../../infra/session-cost-usage.js";
import type { DiagnosticStabilitySnapshot } from "../../logging/diagnostic-stability.js";
import { defaultRuntime } from "../../runtime.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import { inheritOptionFromParent } from "../command-options.js";
import { addGatewayServiceCommands } from "../daemon-cli/register-service-commands.js";
import {
  addGatewayClientOptions,
  callGatewayFromCliWithTransport,
  resolveGatewayRpcOptions,
  resolveGatewayRpcOptionsWithLocalPort,
} from "../gateway-rpc.js";
import { formatHelpExamples } from "../help-format.js";
import { parseOptionalPositiveInteger } from "../parse-positive-integer.js";
import { parseTimeoutMsWithFallback } from "../parse-timeout.js";
import { setCommandJsonMode } from "../program/json-mode.js";
import type { GatewayDiscoverOpts } from "./discover.js";
import { gatewayAction } from "./gateway-action.js";
import { isGatewayMachineOutput } from "./output-mode.js";
import { addGatewayLockRecoveryCommand } from "./register-recover-lock.js";
import { addGatewayRestartHandoffCommands } from "./register-restart-handoff.js";
import { addGatewayRunCommand } from "./run-command.js";
import { normalizeStabilityBundleTarget } from "./stability-bundle-target.js";
import { formatStabilityBytes, formatStabilityEvent } from "./stability-format.js";
import { runGatewayResume, runGatewaySuspend } from "./suspend-cli.js";

type GatewayRpcOpts = Parameters<typeof callGatewayFromCliWithTransport>[1];

const loadWideAreaDnsModule = createLazyPromise(() => import("../../infra/widearea-dns.js"));
const loadCostUsageRenderer = createLazyPromise(() => import("./usage-cost-renderer.js"));
const loadStabilityBundleModule = createLazyPromise(
  () => import("../../logging/diagnostic-stability-bundle.js"),
);

const DEFAULT_GATEWAY_RPC_TIMEOUT_MS = 10_000;
const SETUP_INFERENCE_DETECT_RPC_TIMEOUT_MS = 40_000;

function gatewayCallOpts(cmd: Command): Command {
  return addGatewayClientOptions(cmd, { timeoutMs: DEFAULT_GATEWAY_RPC_TIMEOUT_MS }).option(
    "--json",
    "Output JSON",
    false,
  );
}

async function callGatewayReadOnlyCli(method: string, opts: GatewayRpcOpts, params?: unknown) {
  return await callGatewayFromCliWithTransport(method, opts, params, {
    defaultTimeoutMs: DEFAULT_GATEWAY_RPC_TIMEOUT_MS,
    sharedStateMode: "read-only",
  });
}

function parseGatewayCallParams(value = "{}"): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("--params must be valid JSON.");
  }
}

function parseDaysOption(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  if (typeof raw === "string") {
    const parsed = parseStrictPositiveInteger(raw);
    if (parsed !== undefined) {
      return parsed;
    }
    // A present but malformed value is operator error, like an invalid --timeout.
    throw new Error(`Invalid --days. Use a positive integer, e.g. --days 30. Received: "${raw}".`);
  }
  return 30;
}

async function printGatewayResult(
  json: boolean | undefined,
  result: unknown,
  render: (rich: boolean) => string[] | Promise<string[]>,
): Promise<void> {
  if (json) {
    defaultRuntime.writeJson(result);
    return;
  }
  for (const line of await render(isRich())) {
    defaultRuntime.log(line);
  }
}

function renderStabilitySummary(snapshot: DiagnosticStabilitySnapshot, rich: boolean): string[] {
  const lines = [
    colorize(rich, theme.heading, "Gateway Stability"),
    `${colorize(rich, theme.muted, "Events:")} ${snapshot.count}/${snapshot.capacity}${
      snapshot.dropped > 0 ? ` · dropped=${snapshot.dropped}` : ""
    }`,
  ];

  const topTypes = Object.entries(snapshot.summary.byType)
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([type, count]) => `${type}=${count}`)
    .join(", ");
  if (topTypes) {
    lines.push(`${colorize(rich, theme.muted, "Types:")} ${topTypes}`);
  }

  const memory = snapshot.summary.memory;
  if (memory) {
    lines.push(
      `${colorize(rich, theme.muted, "Memory:")} rss=${formatStabilityBytes(
        memory.latest?.rssBytes,
      )} heap=${formatStabilityBytes(memory.latest?.heapUsedBytes)} maxRss=${formatStabilityBytes(
        memory.maxRssBytes,
      )} pressure=${memory.pressureCount}`,
    );
  }

  const payloadLarge = snapshot.summary.payloadLarge;
  if (payloadLarge) {
    const surfaces = Object.entries(payloadLarge.bySurface)
      .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([surface, count]) => `${surface}=${count}`)
      .join(", ");
    lines.push(
      `${colorize(rich, theme.muted, "Large payloads:")} total=${payloadLarge.count} rejected=${
        payloadLarge.rejected
      } truncated=${payloadLarge.truncated} chunked=${payloadLarge.chunked}${
        surfaces ? ` · ${surfaces}` : ""
      }`,
    );
  }

  if (snapshot.events.length > 0) {
    lines.push(colorize(rich, theme.muted, "Recent:"));
    for (const event of snapshot.events) {
      lines.push(`  ${formatStabilityEvent(event)}`);
    }
  }

  return lines;
}

async function writeSupportExportFromCli(opts: {
  json?: boolean;
  output?: string;
  logLines?: string;
  logBytes?: string;
  stabilityBundle?: string | false;
  rpc?: Pick<GatewayRpcOpts, "url" | "token" | "password" | "timeout">;
}): Promise<void> {
  const { writeDiagnosticSupportExport } =
    await import("../../logging/diagnostic-support-export.js");
  const rpc = {
    url: opts.rpc?.url,
    token: opts.rpc?.token,
    password: opts.rpc?.password,
    timeout: opts.rpc?.timeout ?? "3000",
    json: true,
  };
  const result = await writeDiagnosticSupportExport({
    outputPath: opts.output,
    logLimit: parseOptionalPositiveInteger(opts.logLines, "--log-lines", "."),
    logMaxBytes: parseOptionalPositiveInteger(opts.logBytes, "--log-bytes", "."),
    stabilityBundle: opts.stabilityBundle,
    readStatusSnapshot: async () => {
      const { gatherDaemonStatus } = await import("../daemon-cli/status.gather.js");
      return await gatherDaemonStatus({
        rpc,
        probe: true,
        requireRpc: false,
        deep: false,
      });
    },
    readHealthSnapshot: async () => await callGatewayReadOnlyCli("health", rpc),
    readGatewayCapabilities: async () =>
      await callGatewayReadOnlyCli("diagnostics.capabilities", rpc),
  });
  await printGatewayResult(opts.json, result, (rich) => [
    colorize(rich, theme.heading, "Diagnostics export"),
    `${colorize(rich, theme.muted, "Path:")} ${result.path}`,
    `${colorize(rich, theme.muted, "Size:")} ${formatStabilityBytes(result.bytes)}`,
    `${colorize(rich, theme.muted, "Files:")} ${result.manifest.contents.length}`,
    `${colorize(rich, theme.muted, "Privacy:")} payload-free stability, sanitized logs/status/health/config`,
  ]);
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
            ["openclaw gateway status", "Show service status plus connectivity/capability."],
            ["openclaw gateway auth-token --show", "Reveal the shared token interactively."],
            ["openclaw gateway discover", "Find local and wide-area gateway beacons."],
            ["openclaw gateway stability", "Show recent stability diagnostics."],
            ["openclaw gateway call health", "Call a gateway RPC method directly."],
          ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`,
      ),
  );

  addGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
  );

  addGatewayServiceCommands(gateway, {
    statusDescription: "Show gateway service status + check connectivity/capability",
  });
  addGatewayRestartHandoffCommands(gateway);
  addGatewayLockRecoveryCommand(gateway);
  setCommandJsonMode(gateway, "output", ({ argv }) => isGatewayMachineOutput(argv));

  gateway
    .command("auth-token")
    .description("Reveal the configured shared Gateway token")
    .option("--show", "Print the token to an interactive terminal", false)
    .action(
      gatewayAction(async (opts) => {
        if (!opts.show) {
          throw new Error(
            "Pass --show to confirm that you want to print the Gateway token to this terminal.",
          );
        }
        const { gatewayAuthTokenCommand } = await import("../../commands/gateway-auth-token.js");
        await gatewayAuthTokenCommand(defaultRuntime);
      }, "Gateway auth token failed"),
    );

  gatewayCallOpts(
    gateway
      .command("call")
      .description("Call a Gateway method")
      .argument("<method>", "Method name (health/status/system-presence/cron.*)")
      .option(
        "--expect-url <url>",
        "Fail if the resolved Gateway URL differs; preserves configured authentication",
      )
      .option("--params <json>", "JSON object string for params", "{}")
      .action(
        gatewayAction(async (method, opts, command) => {
          // Setup detection owns a 30s worker deadline; its transport must
          // leave enough grace for the Gateway to return the typed outcome.
          const callOpts =
            method === "openclaw.setup.detect" &&
            command.getOptionValueSource("timeout") === "default"
              ? { ...opts, timeout: String(SETUP_INFERENCE_DETECT_RPC_TIMEOUT_MS) }
              : opts;
          const rpcOpts = resolveGatewayRpcOptionsWithLocalPort(callOpts, command);
          const params = parseGatewayCallParams(String(opts.params ?? "{}"));
          const result = await callGatewayReadOnlyCli(method, rpcOpts, params);
          if (rpcOpts.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          const rich = isRich();
          defaultRuntime.log(
            `${colorize(rich, theme.heading, "Gateway call")}: ${colorize(rich, theme.muted, String(method))}`,
          );
          defaultRuntime.writeJson(result);
        }, "Gateway call failed"),
      ),
  );

  gatewayCallOpts(
    gateway
      .command("suspend")
      .description("Prepare the Gateway for cooperative host suspension")
      .option("--request-id <id>", "Stable suspension request id")
      .option("--wait <seconds>", "Wait up to this many seconds for active work to drain")
      .action(
        gatewayAction(async (opts, command) => {
          const rpcOpts = resolveGatewayRpcOptionsWithLocalPort(opts, command);
          await runGatewaySuspend(
            {
              rpcOpts,
              requestId: opts.requestId,
              waitSeconds: opts.wait,
              json: Boolean(rpcOpts.json),
            },
            { callGateway: callGatewayReadOnlyCli, runtime: defaultRuntime },
          );
        }, "Gateway suspend failed"),
      ),
  );

  gatewayCallOpts(
    gateway
      .command("resume")
      .description("Release a cooperative Gateway suspension")
      .argument("<suspensionId>", "Suspension id returned by gateway suspend")
      .action(
        gatewayAction(async (suspensionId, opts, command) => {
          const rpcOpts = resolveGatewayRpcOptionsWithLocalPort(opts, command);
          await runGatewayResume(
            { rpcOpts, suspensionId: String(suspensionId), json: Boolean(rpcOpts.json) },
            { callGateway: callGatewayReadOnlyCli, runtime: defaultRuntime },
          );
        }, "Gateway resume failed"),
      ),
  );

  gatewayCallOpts(
    gateway
      .command("usage-cost")
      .description("Fetch usage cost summary from session logs")
      .option("--days <days>", "Number of days to include", "30")
      .option("--agent <id>", "Scope the cost summary to a specific agent id")
      .option("--all-agents", "Aggregate the cost summary across all agents", false)
      .action(
        gatewayAction(async (opts, command) => {
          const rpcOpts = resolveGatewayRpcOptionsWithLocalPort(opts, command);
          const days = parseDaysOption(opts.days);
          const agentId = typeof opts.agent === "string" ? opts.agent.trim() : undefined;
          // The gateway honors agentScope only when no agentId is set, so reject the
          // ambiguous combination here instead of silently dropping --all-agents.
          if (agentId && opts.allAgents) {
            throw new Error("Use --agent or --all-agents, not both");
          }
          const summary = (await callGatewayReadOnlyCli("usage.cost", rpcOpts, {
            days,
            ...(agentId ? { agentId } : {}),
            ...(opts.allAgents ? { agentScope: "all" } : {}),
          })) as CostUsageSummary;
          await printGatewayResult(rpcOpts.json, summary, async (rich) =>
            (await loadCostUsageRenderer()).renderGatewayCostUsageSummary(summary, days, rich),
          );
        }, "Gateway usage cost failed"),
      ),
  );

  gatewayCallOpts(
    gateway
      .command("health")
      .description("Fetch Gateway health")
      .action(
        gatewayAction(async (opts, command) => {
          const rpcOpts = resolveGatewayRpcOptionsWithLocalPort(opts, command);
          let result: unknown;
          try {
            result = await callGatewayReadOnlyCli("health", rpcOpts);
          } catch (error) {
            const { emitReachableGatewayAuthDiagnostic, readNonObservingHealthConfig } =
              await import("../../commands/health.js");
            const handled = await emitReachableGatewayAuthDiagnostic({
              error,
              config: rpcOpts.config ?? (await readNonObservingHealthConfig()),
              runtime: defaultRuntime,
              timeoutMs: parseTimeoutMsWithFallback(rpcOpts.timeout, 10_000, {
                invalidType: "error",
              }),
              token: rpcOpts.token,
              password: rpcOpts.password,
              localPortOverride: rpcOpts.localPortOverride,
              json: Boolean(rpcOpts.json),
            });
            if (handled) {
              return;
            }
            throw error;
          }
          if (rpcOpts.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          const [{ formatHealthChannelLines }, { styleHealthChannelLine }] = await Promise.all([
            import("../../commands/health.js"),
            import("../../../packages/terminal-core/src/health-style.js"),
          ]);
          const rich = isRich();
          const obj: Record<string, unknown> =
            result && typeof result === "object" ? (result as Record<string, unknown>) : {};
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
        }, undefined),
      ),
  );

  gatewayCallOpts(
    gateway
      .command("stability")
      .description("Fetch payload-free Gateway stability diagnostics")
      .option("--limit <limit>", "Maximum number of recent events", "25")
      .option("--type <type>", "Filter by diagnostic event type")
      .option("--since-seq <seq>", "Only include events after this sequence")
      .option(
        "--bundle [path]",
        'Read a persisted stability bundle instead of calling Gateway; pass "latest" for newest',
      )
      .option("--export", "Write a shareable support diagnostics export", false)
      .option("--output <path>", "Diagnostics export output .zip path")
      .action(
        gatewayAction(async (opts, command) => {
          const { normalizeDiagnosticStabilityQuery, selectDiagnosticStabilitySnapshot } =
            await import("../../logging/diagnostic-stability.js");
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const query = normalizeDiagnosticStabilityQuery(
            {
              limit: opts.limit,
              sinceSeq: opts.sinceSeq,
              type: opts.type,
            },
            { defaultLimit: 25 },
          );
          const bundleTarget = normalizeStabilityBundleTarget(opts.bundle);
          if (opts.export) {
            await writeSupportExportFromCli({
              json: rpcOpts.json,
              output: opts.output,
              stabilityBundle: bundleTarget ?? "latest",
              rpc: rpcOpts,
            });
            return;
          }
          if (bundleTarget) {
            const {
              readDiagnosticStabilityBundleFileSync,
              readLatestDiagnosticStabilityBundleSync,
            } = await loadStabilityBundleModule();
            const result =
              bundleTarget === "latest"
                ? readLatestDiagnosticStabilityBundleSync()
                : readDiagnosticStabilityBundleFileSync(bundleTarget);
            if (result.status === "missing") {
              throw new Error(`No stability bundles found in ${result.dir}`);
            }
            if (result.status === "failed") {
              throw new Error(
                result.error instanceof Error ? result.error.message : String(result.error),
              );
            }
            const snapshot = selectDiagnosticStabilitySnapshot(result.bundle.snapshot, query);
            await printGatewayResult(
              rpcOpts.json,
              {
                path: result.path,
                mtimeMs: result.mtimeMs,
                bundle: {
                  ...result.bundle,
                  snapshot,
                },
              },
              (rich) => {
                const { bundle, path } = result;
                const processDetails = [
                  `pid=${bundle.process.pid}`,
                  ...(bundle.process.openclawVersion
                    ? [`openclaw=${bundle.process.openclawVersion}`]
                    : []),
                  ...(bundle.process.buildId ? [`build=${bundle.process.buildId}`] : []),
                  ...(bundle.process.commit ? [`commit=${bundle.process.commit}`] : []),
                  `node=${bundle.process.node}`,
                  `${bundle.process.platform}/${bundle.process.arch}`,
                  `uptime=${Math.round(bundle.process.uptimeMs / 1000)}s`,
                ].join(" ");
                const lines = [
                  colorize(rich, theme.heading, "Stability bundle"),
                  `${colorize(rich, theme.muted, "Path:")} ${path}`,
                  `${colorize(rich, theme.muted, "Generated:")} ${bundle.generatedAt}`,
                  `${colorize(rich, theme.muted, "Reason:")} ${bundle.reason}`,
                  `${colorize(rich, theme.muted, "Process:")} ${processDetails}`,
                  `${colorize(rich, theme.muted, "Host:")} ${bundle.host.hostname}`,
                ];
                if (bundle.error) {
                  const errorParts = [
                    bundle.error.name ? `name=${bundle.error.name}` : "",
                    bundle.error.code ? `code=${bundle.error.code}` : "",
                  ].filter(Boolean);
                  if (errorParts.length > 0) {
                    lines.push(`${colorize(rich, theme.muted, "Error:")} ${errorParts.join(" ")}`);
                  }
                }
                const memoryPressure = bundle.evidence?.memoryPressure;
                if (memoryPressure) {
                  lines.push(
                    `${colorize(rich, theme.muted, "Memory pressure:")} ${memoryPressure.level}/${
                      memoryPressure.reason
                    } rss=${formatStabilityBytes(memoryPressure.memory.rssBytes)} heap=${formatStabilityBytes(
                      memoryPressure.memory.heapUsedBytes,
                    )} threshold=${formatStabilityBytes(memoryPressure.thresholdBytes)}`,
                  );
                  if (memoryPressure.heapStatistics) {
                    lines.push(
                      `${colorize(rich, theme.muted, "V8 heap:")} used=${formatStabilityBytes(
                        memoryPressure.heapStatistics.usedHeapSizeBytes,
                      )} limit=${formatStabilityBytes(
                        memoryPressure.heapStatistics.heapSizeLimitBytes,
                      )} available=${formatStabilityBytes(memoryPressure.heapStatistics.totalAvailableSizeBytes)}`,
                    );
                  }
                  if (memoryPressure.activeResources) {
                    const resources = Object.entries(memoryPressure.activeResources.byType)
                      .map(([type, count]) => `${type}=${count}`)
                      .join(", ");
                    lines.push(
                      `${colorize(rich, theme.muted, "Active resources:")} total=${
                        memoryPressure.activeResources.total
                      }${resources ? ` · ${resources}` : ""}`,
                    );
                  }
                  if (memoryPressure.topSessionFiles?.length) {
                    const files = memoryPressure.topSessionFiles
                      .slice(0, 5)
                      .map((file) => `${file.relativePath}=${formatStabilityBytes(file.sizeBytes)}`)
                      .join(", ");
                    lines.push(`${colorize(rich, theme.muted, "Largest session files:")} ${files}`);
                  }
                }
                lines.push("", ...renderStabilitySummary(snapshot, rich));
                return lines;
              },
            );
            return;
          }

          const result = await callGatewayReadOnlyCli(
            "diagnostics.stability",
            resolveGatewayRpcOptionsWithLocalPort(rpcOpts, command),
            {
              limit: query.limit,
              ...(query.type ? { type: query.type } : {}),
              ...(query.sinceSeq !== undefined ? { sinceSeq: query.sinceSeq } : {}),
            },
          );
          await printGatewayResult(rpcOpts.json, result, (rich) =>
            renderStabilitySummary(result as DiagnosticStabilitySnapshot, rich),
          );
        }, "Gateway stability failed"),
      ),
  );

  const diagnostics = gateway
    .command("diagnostics")
    .description("Export local support diagnostics");
  diagnostics
    .command("export")
    .description("Write a shareable, payload-free diagnostics .zip")
    .option("--output <path>", "Output .zip path")
    .option("--log-lines <count>", "Maximum sanitized log lines to include", "5000")
    .option("--log-bytes <bytes>", "Maximum log bytes to inspect", "1000000")
    .option("--url <url>", "Gateway WebSocket URL for health snapshot")
    .option("--token <token>", "Gateway token for health snapshot")
    .option("--password <password>", "Gateway password for health snapshot")
    .option("--timeout <ms>", "Status/health snapshot timeout in ms", "3000")
    .option("--no-stability-bundle", "Skip persisted stability bundle lookup")
    .option("--json", "Output JSON", false)
    .action(
      gatewayAction(async (opts, command) => {
        const rpcOpts = resolveGatewayRpcOptions(opts, command);
        await writeSupportExportFromCli({
          json: opts.json,
          output: opts.output,
          logLines: opts.logLines,
          logBytes: opts.logBytes,
          stabilityBundle: opts.stabilityBundle === false ? false : "latest",
          rpc: rpcOpts,
        });
      }, "Gateway diagnostics export failed"),
    );

  gateway
    .command("probe")
    .description(
      "Show gateway reachability, auth capability, and read-check summary (local + remote)",
    )
    .option("--url <url>", "Explicit Gateway WebSocket URL (still checks localhost)")
    .option("--port <port>", "Local Gateway port")
    .option("--ssh <target>", "SSH target for remote gateway tunnel (user@host or user@host:port)")
    .option("--ssh-identity <path>", "SSH identity file path")
    .option("--ssh-auto", "Try to derive an SSH target from Bonjour discovery", false)
    .option("--token <token>", "Gateway token (applies to all checks)")
    .option("--password <password>", "Gateway password (applies to all checks)")
    .option("--timeout <ms>", "Overall check budget in ms", "3000")
    .option("--json", "Output JSON", false)
    .action(
      gatewayAction(async (opts, command) => {
        const rpcOpts = resolveGatewayRpcOptions(opts, command);
        const { gatewayStatusCommand } = await import("../../commands/gateway-status.js");
        await gatewayStatusCommand(
          {
            ...rpcOpts,
            port: opts.port ?? inheritOptionFromParent(command, "port"),
          },
          defaultRuntime,
        );
      }, undefined),
    );

  gateway
    .command("discover")
    .description("Discover gateways via Bonjour (local + wide-area if configured)")
    .option("--timeout <ms>", "Per-command timeout in ms", "2000")
    .option("--json", "Output JSON", false)
    .action(
      gatewayAction(async (opts: GatewayDiscoverOpts) => {
        const [
          { readSourceConfigBestEffort },
          { discoverGatewayBeacons, resolveGatewayDiscoveryEndpoint },
          { resolveWideAreaDiscoveryDomain },
          { dedupeBeacons, renderBeaconLines },
          { withProgress },
        ] = await Promise.all([
          import("../../config/read-best-effort-config.runtime.js"),
          import("../../infra/bonjour-discovery.js"),
          loadWideAreaDnsModule(),
          import("./discover.js"),
          import("../progress.js"),
        ]);
        const cfg = await readSourceConfigBestEffort();
        const wideAreaDomain = resolveWideAreaDiscoveryDomain({
          configDomain: cfg.discovery?.wideArea?.domain,
        });
        const timeoutMs = parseTimeoutMsWithFallback(opts.timeout, 2000, {
          invalidType: "error",
        });
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
          (a.displayName || a.instanceName).localeCompare(b.displayName || b.instanceName),
        );

        if (opts.json) {
          const enriched = deduped.map((beacon) => ({
            ...beacon,
            wsUrl: resolveGatewayDiscoveryEndpoint(beacon)?.wsUrl ?? null,
          }));
          defaultRuntime.writeJson({
            timeoutMs,
            domains,
            count: enriched.length,
            beacons: enriched,
          });
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
      }, "gateway discover failed"),
    );
}
