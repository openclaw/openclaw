// Commander registration for gateway status, health, diagnostics, discovery, and run commands.
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { colorize, isRich, theme } from "../../../packages/terminal-core/src/theme.js";
import {
  formatChannelTurnLatencyMetrics,
  formatChannelTurnLatencyMs,
} from "../../commands/channel-turn-latency-format.js";
import type { HealthSummary } from "../../commands/health.js";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";
import type { CostUsageSummary } from "../../infra/session-cost-usage.js";
import type {
  DiagnosticStabilityBundle,
  ReadDiagnosticStabilityBundleResult,
} from "../../logging/diagnostic-stability-bundle.js";
import type {
  DiagnosticStabilityEventRecord,
  DiagnosticStabilitySnapshot,
} from "../../logging/diagnostic-stability.js";
import type { WriteDiagnosticSupportExportResult } from "../../logging/diagnostic-support-export.js";
import { defaultRuntime } from "../../runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { inheritOptionFromParent } from "../command-options.js";
import { addGatewayServiceCommands } from "../daemon-cli/register-service-commands.js";
import { formatHelpExamples } from "../help-format.js";
import type { GatewayRpcOpts } from "./call.js";
import type { GatewayDiscoverOpts } from "./discover.js";
import { addGatewayRunCommand } from "./run-command.js";

const configModuleLoader = createLazyImportLoader(
  () => import("../../config/read-best-effort-config.runtime.js"),
);
const gatewayStatusModuleLoader = createLazyImportLoader(
  () => import("../../commands/gateway-status.js"),
);
const gatewayHealthModuleLoader = createLazyImportLoader(() => import("../../commands/health.js"));
const bonjourDiscoveryModuleLoader = createLazyImportLoader(
  () => import("../../infra/bonjour-discovery.js"),
);
const wideAreaDnsModuleLoader = createLazyImportLoader(() => import("../../infra/widearea-dns.js"));
const healthStyleModuleLoader = createLazyImportLoader(
  () => import("../../../packages/terminal-core/src/health-style.js"),
);
const usageFormatModuleLoader = createLazyImportLoader(() => import("../../utils/usage-format.js"));
const stabilityBundleModuleLoader = createLazyImportLoader(
  () => import("../../logging/diagnostic-stability-bundle.js"),
);
const supportExportModuleLoader = createLazyImportLoader(
  () => import("../../logging/diagnostic-support-export.js"),
);
const daemonStatusGatherModuleLoader = createLazyImportLoader(
  () => import("../daemon-cli/status.gather.js"),
);

function loadConfigModule() {
  return configModuleLoader.load();
}

function loadGatewayStatusModule() {
  return gatewayStatusModuleLoader.load();
}

function loadGatewayHealthModule() {
  return gatewayHealthModuleLoader.load();
}

function loadBonjourDiscoveryModule() {
  return bonjourDiscoveryModuleLoader.load();
}

function loadWideAreaDnsModule() {
  return wideAreaDnsModuleLoader.load();
}

function loadHealthStyleModule() {
  return healthStyleModuleLoader.load();
}

function loadUsageFormatModule() {
  return usageFormatModuleLoader.load();
}

function loadStabilityBundleModule() {
  return stabilityBundleModuleLoader.load();
}

function loadSupportExportModule() {
  return supportExportModuleLoader.load();
}

function loadDaemonStatusGatherModule() {
  return daemonStatusGatherModuleLoader.load();
}

function gatewayCallOpts(cmd: Command): Command {
  return cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--expect-final", "Wait for final response (agent)", false)
    .option("--json", "Output JSON", false);
}

async function callGatewayCli(method: string, opts: GatewayRpcOpts, params?: unknown) {
  const mod = await import("./call.js");
  return mod.callGatewayCli(method, opts, params);
}

async function runGatewayCommand(
  action: () => Promise<void>,
  label?: string,
  opts?: { json?: boolean },
) {
  // JSON mode preserves structured gateway transport errors for automation callers.
  try {
    await action();
  } catch (err) {
    if (opts?.json) {
      const { formatGatewayTransportErrorJson } = await import("../../gateway/call.js");
      const payload = formatGatewayTransportErrorJson(err);
      if (payload) {
        defaultRuntime.writeJson(payload);
        defaultRuntime.exit(1);
        return;
      }
    }
    const message = String(err);
    defaultRuntime.error(label ? `${label}: ${message}` : message);
    defaultRuntime.exit(1);
  }
}

function parseDaysOption(raw: unknown, fallback = 30): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = parseStrictPositiveInteger(raw);
    if (parsed !== undefined) {
      return parsed;
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

async function renderCostUsageSummaryAsync(
  summary: CostUsageSummary,
  days: number,
  rich: boolean,
): Promise<string[]> {
  const { formatTokenCount, formatUsd } = await loadUsageFormatModule();
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

function formatBytes(value: number | undefined): string {
  if (value === undefined) {
    return "n/a";
  }
  const units = ["B", "KiB", "MiB", "GiB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || amount >= 100 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
}

function formatStabilityEvent(record: DiagnosticStabilityEventRecord): string {
  const parts = [
    new Date(record.ts).toISOString(),
    `#${record.seq}`,
    record.type,
    record.level ? `level=${record.level}` : "",
    record.action ? `action=${record.action}` : "",
    record.outcome ? `outcome=${record.outcome}` : "",
    record.surface ? `surface=${record.surface}` : "",
    record.channel ? `channel=${record.channel}` : "",
    record.pluginId ? `plugin=${record.pluginId}` : "",
    record.reason ? `reason=${record.reason}` : "",
    record.classification ? `classification=${record.classification}` : "",
    record.activeWorkKind ? `activeWork=${record.activeWorkKind}` : "",
    record.toolName ? `tool=${record.toolName}` : "",
    record.ageMs !== undefined ? `age=${record.ageMs}ms` : "",
    record.bytes !== undefined ? `bytes=${formatBytes(record.bytes)}` : "",
    record.limitBytes !== undefined ? `limit=${formatBytes(record.limitBytes)}` : "",
    record.queueDepth !== undefined ? `queueDepth=${record.queueDepth}` : "",
    record.queueLength !== undefined ? `queueLength=${record.queueLength}` : "",
    record.messageAgeMs !== undefined ? `messageAge=${record.messageAgeMs}ms` : "",
    record.receivedToTurnStartMs !== undefined
      ? `receivedToStart=${record.receivedToTurnStartMs}ms`
      : "",
    record.startToDeliveryMs !== undefined ? `startToDelivery=${record.startToDeliveryMs}ms` : "",
    record.startToCompletionMs !== undefined
      ? `startToCompletion=${record.startToCompletionMs}ms`
      : "",
    record.droppedEvents !== undefined ? `dropped=${record.droppedEvents}` : "",
    record.maxQueueLength !== undefined ? `maxQueue=${record.maxQueueLength}` : "",
    record.queued !== undefined ? `queued=${record.queued}` : "",
    record.memory ? `rss=${formatBytes(record.memory.rssBytes)}` : "",
    record.memory ? `heap=${formatBytes(record.memory.heapUsedBytes)}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function formatSessionAttentionSummary(
  sessions: NonNullable<DiagnosticStabilitySnapshot["summary"]["sessions"]>,
  rich: boolean,
): string[] {
  const attention = sessions.attention;
  const lines = [
    `${colorize(rich, theme.muted, "Session attention:")} longRunning=${
      attention.longRunning
    } stalled=${attention.stalled} stuck=${attention.stuck} recoveryRequested=${
      attention.recoveryRequested
    } recoveryCompleted=${attention.recoveryCompleted}`,
  ];
  const classifications = Object.entries(attention.byClassification)
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([classification, count]) => `${classification}:${count}`)
    .join(", ");
  if (classifications) {
    lines.push(`  ${colorize(rich, theme.muted, "Classifications:")} ${classifications}`);
  }
  const activeWork = Object.entries(attention.byActiveWorkKind)
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([kind, count]) => `${kind}:${count}`)
    .join(", ");
  if (activeWork) {
    lines.push(`  ${colorize(rich, theme.muted, "Active work:")} ${activeWork}`);
  }
  if (attention.recent.length > 0) {
    lines.push(`  ${colorize(rich, theme.muted, "Recent session attention:")}`);
    for (const event of attention.recent.slice(-3)) {
      const parts = [
        new Date(event.ts).toISOString(),
        `#${event.seq}`,
        event.type,
        event.sessionKey ? `session=${event.sessionKey}` : "",
        event.classification ? `classification=${event.classification}` : "",
        event.reason ? `reason=${event.reason}` : "",
        event.activeWorkKind ? `activeWork=${event.activeWorkKind}` : "",
        event.toolName ? `tool=${event.toolName}` : "",
        event.ageMs !== undefined ? `age=${event.ageMs}ms` : "",
        event.queueDepth !== undefined ? `queueDepth=${event.queueDepth}` : "",
      ].filter(Boolean);
      lines.push(`    ${parts.join(" ")}`);
    }
  }
  return lines;
}

function formatQueueSummary(
  queues: NonNullable<DiagnosticStabilitySnapshot["summary"]["queues"]>,
  rich: boolean,
): string[] {
  const lines = [
    `${colorize(rich, theme.muted, "Queues:")} enqueued=${queues.enqueued} dequeued=${
      queues.dequeued
    } slow=${queues.slowDequeues} maxWait=${formatChannelTurnLatencyMs(
      queues.maxWaitMs,
    )} maxQueue=${queues.maxQueueSize ?? "unknown"}`,
  ];
  const lanes = Object.entries(queues.byLane)
    .toSorted((a, b) => {
      const slowDelta = b[1].slowDequeues - a[1].slowDequeues;
      if (slowDelta !== 0) {
        return slowDelta;
      }
      return (b[1].maxWaitMs ?? 0) - (a[1].maxWaitMs ?? 0);
    })
    .slice(0, 5)
    .map(
      ([lane, summary]) =>
        `${lane}=enq:${summary.enqueued}/deq:${summary.dequeued}/slow:${
          summary.slowDequeues
        }/maxWait:${formatChannelTurnLatencyMs(summary.maxWaitMs)}/maxQueue:${
          summary.maxQueueSize ?? "unknown"
        }`,
    )
    .join(", ");
  if (lanes) {
    lines.push(`  ${colorize(rich, theme.muted, "Lanes:")} ${lanes}`);
  }
  if (queues.recentSlow.length > 0) {
    lines.push(`  ${colorize(rich, theme.muted, "Recent slow queue waits:")}`);
    for (const slow of queues.recentSlow.slice(-3)) {
      const parts = [
        new Date(slow.ts).toISOString(),
        `#${slow.seq}`,
        `lane=${slow.lane}`,
        `wait=${slow.waitMs}ms`,
        slow.queueSize !== undefined ? `queueSize=${slow.queueSize}` : "",
      ].filter(Boolean);
      lines.push(`    ${parts.join(" ")}`);
    }
  }
  return lines;
}

function formatChannelTurnSlaSummary(
  channelTurns: NonNullable<DiagnosticStabilitySnapshot["summary"]["channelTurns"]>,
  rich: boolean,
): string[] {
  const lines = [
    `${colorize(rich, theme.muted, "Channel turns:")} events=${
      channelTurns.totalEvents
    } required=${channelTurns.deliveryRequired} sent=${channelTurns.deliverySent} failed=${
      channelTurns.deliveryFailed
    } invalid=${channelTurns.invalidCompletions} missingVisible=${
      channelTurns.missingVisibleDelivery
    } health=${channelTurns.health.status}`,
  ];

  const channelBreakdown = Object.entries(channelTurns.byChannel)
    .toSorted((a, b) => {
      const missingDelta = b[1].missingVisibleDelivery - a[1].missingVisibleDelivery;
      if (missingDelta !== 0) {
        return missingDelta;
      }
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 5)
    .map(
      ([channel, counts]) =>
        `${channel}=required:${counts.deliveryRequired}/sent:${counts.deliverySent}/failed:${counts.deliveryFailed}/missing:${counts.missingVisibleDelivery}`,
    )
    .join(", ");
  if (channelBreakdown) {
    lines.push(`  ${channelBreakdown}`);
  }

  const tools = channelTurns.tools;
  if (tools && (tools.called > 0 || tools.results > 0)) {
    lines.push(
      `  ${colorize(rich, theme.muted, "Tools:")} called=${tools.called} results=${
        tools.results
      } failed=${tools.failedResults} missing=${tools.missingResults} slow=${
        tools.slowResults
      } preDelivery=${tools.preDeliveryCalls} slowPreDelivery=${tools.slowPreDeliveryResults}`,
    );
    const toolBreakdown = Object.entries(tools.byTool)
      .toSorted((a, b) => {
        const failureDelta =
          b[1].failedResults + b[1].missingResults - (a[1].failedResults + a[1].missingResults);
        if (failureDelta !== 0) {
          return failureDelta;
        }
        const durationDelta = (b[1].maxDurationMs ?? 0) - (a[1].maxDurationMs ?? 0);
        if (durationDelta !== 0) {
          return durationDelta;
        }
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 5)
      .map(
        ([toolName, counts]) =>
          `${toolName}=called:${counts.called}/results:${counts.results}/failed:${
            counts.failedResults
          }/missing:${counts.missingResults}/preDelivery:${
            counts.preDeliveryCalls
          }/max:${formatChannelTurnLatencyMs(counts.maxDurationMs)}`,
      )
      .join(", ");
    if (toolBreakdown) {
      lines.push(`  ${toolBreakdown}`);
    }
  }

  if (tools?.recentPreDeliverySlow.length) {
    lines.push(`  ${colorize(rich, theme.muted, "Recent slow pre-delivery tools:")}`);
    for (const slow of tools.recentPreDeliverySlow.slice(-3)) {
      const parts = [
        new Date(slow.ts).toISOString(),
        `#${slow.seq}`,
        slow.channel ? `channel=${slow.channel}` : "",
        slow.turnId ? `turn=${slow.turnId}` : "",
        slow.toolName ? `tool=${slow.toolName}` : "",
        `duration=${slow.durationMs}ms`,
      ].filter(Boolean);
      lines.push(`    ${parts.join(" ")}`);
    }
  }

  const latency = channelTurns.latency;
  if (latency) {
    const latencyParts = formatChannelTurnLatencyMetrics(latency, {
      assign: ":",
      separator: "/",
    });
    if (latencyParts.length > 0) {
      lines.push(`  ${colorize(rich, theme.muted, "Latency:")} ${latencyParts.join(", ")}`);
    }
    if (latency.bottleneck) {
      lines.push(
        `  ${colorize(rich, theme.muted, "Latency bottleneck:")} phase=${
          latency.bottleneck.phase
        } metric=${latency.bottleneck.metric} max=${formatChannelTurnLatencyMs(
          latency.bottleneck.maxMs,
        )} slow=${latency.bottleneck.slowCount}/${latency.bottleneck.count}`,
      );
    }
    if (latency.recentSlow.length > 0) {
      lines.push(`  ${colorize(rich, theme.muted, "Recent slow channel turns:")}`);
      for (const slow of latency.recentSlow.slice(-3)) {
        const parts = [
          new Date(slow.ts).toISOString(),
          `#${slow.seq}`,
          slow.channel ? `channel=${slow.channel}` : "",
          slow.turnId ? `turn=${slow.turnId}` : "",
          slow.messageId ? `message=${slow.messageId}` : "",
          `${slow.metric}=${slow.valueMs}ms`,
        ].filter(Boolean);
        lines.push(`    ${parts.join(" ")}`);
      }
    }
  }

  if (channelTurns.health.issues.length > 0) {
    lines.push(`  ${colorize(rich, theme.muted, "Health issues:")}`);
    for (const issue of channelTurns.health.issues.slice(0, 5)) {
      const parts = [
        `${issue.level}:${issue.code}`,
        issue.metric && issue.valueMs !== undefined ? `${issue.metric}=${issue.valueMs}ms` : "",
        issue.count !== undefined ? `count=${issue.count}` : "",
      ].filter(Boolean);
      lines.push(`    ${parts.join(" ")} · ${issue.guidance}`);
    }
  }

  if (channelTurns.recentFailures.length > 0) {
    lines.push(`  ${colorize(rich, theme.muted, "Recent delivery failures:")}`);
    for (const failure of channelTurns.recentFailures.slice(-3)) {
      const parts = [
        new Date(failure.ts).toISOString(),
        `#${failure.seq}`,
        failure.channel ? `channel=${failure.channel}` : "",
        failure.turnId ? `turn=${failure.turnId}` : "",
        failure.messageId ? `message=${failure.messageId}` : "",
        failure.reason ? `reason=${failure.reason}` : "",
      ].filter(Boolean);
      lines.push(`    ${parts.join(" ")}`);
    }
  }

  return lines;
}

function formatControlLaneHealthSummary(
  controlLane: NonNullable<DiagnosticStabilitySnapshot["summary"]["controlLane"]>,
  rich: boolean,
): string[] {
  const lines = [
    `${colorize(rich, theme.muted, "Control lane:")} status=${
      controlLane.status
    } required=${controlLane.deliveryRequired} sent=${controlLane.deliverySent} failed=${
      controlLane.deliveryFailed
    } missing=${controlLane.missingVisibleDelivery} slowIngress=${
      controlLane.slowIngress
    } slowQueue=${controlLane.slowQueue} slowVisible=${controlLane.slowVisibleDelivery}`,
  ];
  if (controlLane.reasons.length > 0) {
    lines.push(`  ${colorize(rich, theme.muted, "Reasons:")} ${controlLane.reasons.join(", ")}`);
  }
  const metrics = [
    controlLane.maxMessageAgeMs !== undefined
      ? `maxMessageAge=${formatChannelTurnLatencyMs(controlLane.maxMessageAgeMs)}`
      : "",
    controlLane.maxQueueWaitMs !== undefined
      ? `maxQueueWait=${formatChannelTurnLatencyMs(controlLane.maxQueueWaitMs)}`
      : "",
    controlLane.maxReceiveToStartMs !== undefined
      ? `maxReceiveToStart=${formatChannelTurnLatencyMs(controlLane.maxReceiveToStartMs)}`
      : "",
    controlLane.maxStartToDeliveryMs !== undefined
      ? `maxStartToDelivery=${formatChannelTurnLatencyMs(controlLane.maxStartToDeliveryMs)}`
      : "",
  ].filter(Boolean);
  if (metrics.length > 0) {
    lines.push(`  ${colorize(rich, theme.muted, "Metrics:")} ${metrics.join(", ")}`);
  }
  lines.push(`  ${controlLane.guidance}`);
  return lines;
}

function formatRuntimeRecommendations(
  recommendations: NonNullable<DiagnosticStabilitySnapshot["summary"]["recommendations"]>,
  rich: boolean,
): string[] {
  const lines = [colorize(rich, theme.muted, "Runtime recommendations:")];
  for (const recommendation of recommendations.slice(0, 5)) {
    const parts = [
      `${recommendation.priority}:${recommendation.code}`,
      `source=${recommendation.source}`,
      `reason=${recommendation.reason}`,
      recommendation.metric ? `metric=${recommendation.metric}` : "",
      recommendation.valueMs !== undefined
        ? `value=${formatChannelTurnLatencyMs(recommendation.valueMs)}`
        : "",
      recommendation.count !== undefined ? `count=${recommendation.count}` : "",
    ].filter(Boolean);
    lines.push(`  ${parts.join(" ")} · ${recommendation.guidance}`);
  }
  return lines;
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
      `${colorize(rich, theme.muted, "Memory:")} rss=${formatBytes(
        memory.latest?.rssBytes,
      )} heap=${formatBytes(memory.latest?.heapUsedBytes)} maxRss=${formatBytes(
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

  const channelTurns = snapshot.summary.channelTurns;
  if (channelTurns) {
    lines.push(...formatChannelTurnSlaSummary(channelTurns, rich));
  }

  const sessions = snapshot.summary.sessions;
  if (sessions) {
    lines.push(...formatSessionAttentionSummary(sessions, rich));
  }

  const queues = snapshot.summary.queues;
  if (queues) {
    lines.push(...formatQueueSummary(queues, rich));
  }

  const controlLane = snapshot.summary.controlLane;
  if (controlLane) {
    lines.push(...formatControlLaneHealthSummary(controlLane, rich));
  }

  const recommendations = snapshot.summary.recommendations;
  if (recommendations && recommendations.length > 0) {
    lines.push(...formatRuntimeRecommendations(recommendations, rich));
  }

  if (snapshot.events.length > 0) {
    lines.push(colorize(rich, theme.muted, "Recent:"));
    for (const event of snapshot.events) {
      lines.push(`  ${formatStabilityEvent(event)}`);
    }
  }

  return lines;
}

function normalizeStabilityBundleTarget(raw: unknown): string | null {
  if (raw === undefined || raw === false) {
    return null;
  }
  if (raw === true) {
    return "latest";
  }
  if (typeof raw !== "string") {
    return "latest";
  }
  const value = raw.trim();
  return value === "" ? "latest" : value;
}

function formatBundleError(result: ReadDiagnosticStabilityBundleResult): string {
  if (result.status === "missing") {
    return `No stability bundles found in ${result.dir}`;
  }
  if (result.status === "failed") {
    return result.error instanceof Error ? result.error.message : String(result.error);
  }
  return "Unexpected stability bundle read result";
}

async function readStabilityBundleTarget(
  bundleTarget: string,
): Promise<ReadDiagnosticStabilityBundleResult> {
  const { readDiagnosticStabilityBundleFileSync, readLatestDiagnosticStabilityBundleSync } =
    await loadStabilityBundleModule();
  return bundleTarget === "latest"
    ? readLatestDiagnosticStabilityBundleSync()
    : readDiagnosticStabilityBundleFileSync(bundleTarget);
}

function renderStabilityBundleSummary(params: {
  bundle: DiagnosticStabilityBundle;
  path: string;
  snapshot: DiagnosticStabilitySnapshot;
  rich: boolean;
}): string[] {
  const { bundle, path, rich, snapshot } = params;
  const processDetails = [
    `pid=${bundle.process.pid}`,
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
      } rss=${formatBytes(memoryPressure.memory.rssBytes)} heap=${formatBytes(
        memoryPressure.memory.heapUsedBytes,
      )} threshold=${formatBytes(memoryPressure.thresholdBytes)}`,
    );
    if (memoryPressure.heapStatistics) {
      lines.push(
        `${colorize(rich, theme.muted, "V8 heap:")} used=${formatBytes(
          memoryPressure.heapStatistics.usedHeapSizeBytes,
        )} limit=${formatBytes(
          memoryPressure.heapStatistics.heapSizeLimitBytes,
        )} available=${formatBytes(memoryPressure.heapStatistics.totalAvailableSizeBytes)}`,
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
        .map((file) => `${file.relativePath}=${formatBytes(file.sizeBytes)}`)
        .join(", ");
      lines.push(`${colorize(rich, theme.muted, "Largest session files:")} ${files}`);
    }
  }
  lines.push("", ...renderStabilitySummary(snapshot, rich));
  return lines;
}

function renderSupportExportResult(
  result: WriteDiagnosticSupportExportResult,
  rich: boolean,
): string[] {
  return [
    colorize(rich, theme.heading, "Diagnostics export"),
    `${colorize(rich, theme.muted, "Path:")} ${result.path}`,
    `${colorize(rich, theme.muted, "Size:")} ${formatBytes(result.bytes)}`,
    `${colorize(rich, theme.muted, "Files:")} ${result.manifest.contents.length}`,
    `${colorize(rich, theme.muted, "Privacy:")} payload-free stability, sanitized logs/status/health/config`,
  ];
}

function resolveSupportExportRpcOptions(
  rpc?: Pick<GatewayRpcOpts, "url" | "token" | "password" | "timeout">,
): GatewayRpcOpts {
  return {
    url: rpc?.url,
    token: rpc?.token,
    password: rpc?.password,
    timeout: rpc?.timeout ?? "3000",
    json: true,
  };
}

function parseOptionalPositiveIntegerOption(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  const parsed = parseStrictPositiveInteger(raw);
  if (parsed === undefined) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

async function writeSupportExportFromCli(opts: {
  json?: boolean;
  output?: string;
  logLines?: string;
  logBytes?: string;
  stabilityBundle?: string | false;
  rpc?: Pick<GatewayRpcOpts, "url" | "token" | "password" | "timeout">;
}): Promise<void> {
  const { writeDiagnosticSupportExport } = await loadSupportExportModule();
  const rpc = resolveSupportExportRpcOptions(opts.rpc);
  const result = await writeDiagnosticSupportExport({
    outputPath: opts.output,
    logLimit: parseOptionalPositiveIntegerOption(opts.logLines, "--log-lines"),
    logMaxBytes: parseOptionalPositiveIntegerOption(opts.logBytes, "--log-bytes"),
    stabilityBundle: opts.stabilityBundle,
    readStatusSnapshot: async () => {
      const { gatherDaemonStatus } = await loadDaemonStatusGatherModule();
      return await gatherDaemonStatus({
        rpc,
        probe: true,
        requireRpc: false,
        deep: false,
      });
    },
    readHealthSnapshot: async () => await callGatewayCli("health", rpc),
  });
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  const rich = isRich();
  for (const line of renderSupportExportResult(result, rich)) {
    defaultRuntime.log(line);
  }
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
    statusDescription: "Show gateway service status + probe connectivity/capability",
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
            defaultRuntime.writeJson(result);
            return;
          }
          const rich = isRich();
          defaultRuntime.log(
            `${colorize(rich, theme.heading, "Gateway call")}: ${colorize(rich, theme.muted, String(method))}`,
          );
          defaultRuntime.writeJson(result);
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
            defaultRuntime.writeJson(result);
            return;
          }
          const rich = isRich();
          const summary = result as CostUsageSummary;
          for (const line of await renderCostUsageSummaryAsync(summary, days, rich)) {
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
        await runGatewayCommand(
          async () => {
            const rpcOpts = resolveGatewayRpcOptions(opts, command);
            const [{ formatHealthChannelLines }, { styleHealthChannelLine }] = await Promise.all([
              loadGatewayHealthModule(),
              loadHealthStyleModule(),
            ]);
            const result = await callGatewayCli("health", rpcOpts);
            if (rpcOpts.json) {
              defaultRuntime.writeJson(result);
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
          },
          undefined,
          { json: Boolean(opts.json) },
        );
      }),
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
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
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
            const result = await readStabilityBundleTarget(bundleTarget);
            if (result.status !== "found") {
              throw new Error(formatBundleError(result));
            }
            const snapshot = selectDiagnosticStabilitySnapshot(result.bundle.snapshot, query);
            if (rpcOpts.json) {
              defaultRuntime.writeJson({
                path: result.path,
                mtimeMs: result.mtimeMs,
                bundle: {
                  ...result.bundle,
                  snapshot,
                },
              });
              return;
            }
            const rich = isRich();
            for (const line of renderStabilityBundleSummary({
              bundle: result.bundle,
              path: result.path,
              rich,
              snapshot,
            })) {
              defaultRuntime.log(line);
            }
            return;
          }

          const result = await callGatewayCli("diagnostics.stability", rpcOpts, {
            limit: query.limit,
            ...(query.type ? { type: query.type } : {}),
            ...(query.sinceSeq !== undefined ? { sinceSeq: query.sinceSeq } : {}),
          });
          if (rpcOpts.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          const rich = isRich();
          for (const line of renderStabilitySummary(result as DiagnosticStabilitySnapshot, rich)) {
            defaultRuntime.log(line);
          }
        }, "Gateway stability failed");
      }),
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
    .action(async (opts, command) => {
      await runGatewayCommand(async () => {
        const rpcOpts = resolveGatewayRpcOptions(opts, command);
        await writeSupportExportFromCli({
          json: opts.json,
          output: opts.output,
          logLines: opts.logLines,
          logBytes: opts.logBytes,
          stabilityBundle: opts.stabilityBundle === false ? false : "latest",
          rpc: rpcOpts,
        });
      }, "Gateway diagnostics export failed");
    });

  gateway
    .command("probe")
    .description(
      "Show gateway reachability, auth capability, and read-probe summary (local + remote)",
    )
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
        const { gatewayStatusCommand } = await loadGatewayStatusModule();
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
        const [
          { readSourceConfigBestEffort },
          { discoverGatewayBeacons },
          { resolveWideAreaDiscoveryDomain },
          {
            dedupeBeacons,
            parseDiscoverTimeoutMs,
            pickBeaconHost,
            pickGatewayPort,
            renderBeaconLines,
          },
          { withProgress },
        ] = await Promise.all([
          loadConfigModule(),
          loadBonjourDiscoveryModule(),
          loadWideAreaDnsModule(),
          import("./discover.js"),
          import("../progress.js"),
        ]);
        const cfg = await readSourceConfigBestEffort();
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
          (a.displayName || a.instanceName).localeCompare(b.displayName || b.instanceName),
        );

        if (opts.json) {
          const enriched = deduped.map((b) => {
            const host = pickBeaconHost(b);
            const port = pickGatewayPort(b);
            return { ...b, wsUrl: host ? `ws://${host}:${port}` : null };
          });
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
      }, "gateway discover failed");
    });
}
