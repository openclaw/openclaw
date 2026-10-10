// Appends the read-only diagnosis section for `openclaw status --all`.
// Every line that can include logs, config, or connection details is redacted before display.

import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import type { ChannelStatusIssue } from "../../channels/plugins/types.core.js";
import type { ProgressReporter } from "../../cli/progress.js";
import { formatConfigIssueLine } from "../../config/issue-format.js";
import {
  resolveGatewayLogPaths,
  resolveGatewayRestartLogPath,
  resolveGatewaySupervisorLogPaths,
} from "../../daemon/restart-logs.js";
import {
  classifyPortListener,
  formatPortDiagnostics,
  isDualStackLoopbackGatewayListeners,
  isExpectedGatewayListeners,
  type PortUsage,
} from "../../infra/ports.js";
import {
  type RestartSentinelPayload,
  summarizeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import {
  formatPluginCompatibilityNotice,
  type PluginCompatibilityNotice,
} from "../../plugins/status.js";
import { dedupeByKey } from "../../shared/dedupe-by-key.js";
import type { buildWorkspaceSkillReadiness } from "../../skills/discovery/status.js";
import { formatDeliveryQueueHealthLine } from "../health-format.js";
import { countActiveStatusAgents } from "../status-overview-values.js";
import type {
  resolveStatusGatewayHealthSafe,
  StatusGatewayDiagnosticsResult,
} from "../status-runtime-shared.ts";
import {
  formatUpdateRestartActionLines,
  formatUpdateRestartStatusValue,
} from "../status-update-restart.ts";
import type { NodeOnlyGatewayInfo } from "../status.node-mode.js";
import { formatTelemetryExporterSummary } from "../telemetry-exporter-summary.js";
import { formatTimeAgo, redactStatusSecrets } from "./format.js";
import { readFileTailLines, summarizeLogTail } from "./gateway.js";

type ConfigIssueLike = { path: string; message: string };
type ConfigSnapshotLike = {
  exists: boolean;
  valid: boolean;
  path?: string | null;
  legacyIssues?: ConfigIssueLike[] | null;
  issues?: ConfigIssueLike[] | null;
};

type PortUsageLike = Pick<PortUsage, "listeners" | "port" | "status" | "hints">;

type DeliveryDiagnosticsLike = {
  summary?: {
    byType?: Record<string, number>;
  };
  events?: Array<{
    type?: string;
    ts?: number;
    channel?: string;
    outcome?: string;
    reason?: string;
  }>;
};

type AgentStatusLike = Parameters<typeof countActiveStatusAgents>[0]["agentStatus"] & {
  totalSessions: number;
};

const AGENT_ACTIVITY_SOFT_WARNING_MS = 30 * 60_000;

function countGatewayListenerPids(portUsage: PortUsageLike): number {
  const pids = new Set<number>();
  for (const listener of portUsage.listeners) {
    if (classifyPortListener(listener) !== "gateway") {
      continue;
    }
    if (typeof listener.pid === "number" && Number.isFinite(listener.pid)) {
      pids.add(listener.pid);
    }
  }
  return pids.size;
}

function isDeliveryDiagnosticsLike(value: unknown): value is DeliveryDiagnosticsLike {
  return Boolean(value && typeof value === "object");
}

function countDeliveryEvent(snapshot: DeliveryDiagnosticsLike, type: string): number {
  const value = snapshot.summary?.byType?.[type];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function latestDeliveryEventAgeMs(snapshot: DeliveryDiagnosticsLike): number | null {
  // Only inbound/dispatch lifecycle events count as delivery freshness signals.
  const latestTs = (snapshot.events ?? [])
    .filter((event) =>
      [
        "message.received",
        "message.dispatch.started",
        "message.dispatch.completed",
        "session.turn.created",
        "message.processed",
      ].includes(event.type ?? ""),
    )
    .reduce((max, event) => {
      const ts = event.ts;
      return typeof ts === "number" && Number.isFinite(ts) ? Math.max(max, ts) : max;
    }, 0);
  return latestTs > 0 ? Date.now() - latestTs : null;
}

export async function appendStatusAllDiagnosis(params: {
  lines: string[];
  progress: ProgressReporter;
  muted: (text: string) => string;
  ok: (text: string) => string;
  warn: (text: string) => string;
  fail: (text: string) => string;
  connectionDetailsForReport: string;
  snap: ConfigSnapshotLike | null;
  remoteUrlMissing: boolean;
  secretDiagnostics: string[];
  sentinel: { payload?: RestartSentinelPayload | null } | null;
  lastErr: string | null;
  port: number;
  portUsage: PortUsageLike | null;
  tailscaleMode: string;
  tailscaleDns: string | null;
  tailscaleHttpsUrl: string | null;
  skillReadiness: ReturnType<typeof buildWorkspaceSkillReadiness> | null;
  pluginCompatibility: PluginCompatibilityNotice[];
  channelsStatus: unknown;
  channelIssues: ChannelStatusIssue[];
  deliveryDiagnostics: StatusGatewayDiagnosticsResult | null;
  exporterDiagnostics: StatusGatewayDiagnosticsResult | null;
  agentStatus?: AgentStatusLike;
  gatewayReachable: boolean;
  gatewayStartupPhase?: string;
  localGatewayHealthy?: boolean;
  gatewayServer?: NonNullable<
    Parameters<typeof formatUpdateRestartStatusValue>[1]
  >["gatewayServer"];
  health: Awaited<ReturnType<typeof resolveStatusGatewayHealthSafe>> | null | undefined;
  nodeOnlyGateway: NodeOnlyGatewayInfo | null;
}) {
  const { lines, muted, ok, warn, fail } = params;
  const emitDetail = (text: string) => lines.push(`  ${muted(text)}`);
  const emitLimited = <T>(items: T[], limit: number, format: (item: T) => string) => {
    for (const item of items.slice(0, limit)) {
      lines.push(format(item));
    }
    if (items.length > limit) {
      emitDetail(`… +${items.length - limit} more`);
    }
  };

  const emitCheck = (label: string, status: "ok" | "warn" | "fail") => {
    const decorate = status === "ok" ? ok : status === "warn" ? warn : fail;
    const icon = status === "ok" ? "✓" : status === "warn" ? "!" : "✗";
    lines.push(`${decorate(icon)} ${decorate(label)}`);
  };
  const emitUnavailableDiagnostics = (diagnostic: {
    label: string;
    detail: string;
    retry: string;
  }) => {
    emitCheck(`${diagnostic.label}: unavailable`, "warn");
    emitDetail(
      sanitizeTerminalText(redactStatusSecrets(redactSensitiveUrlLikeString(diagnostic.detail))),
    );
    emitDetail(`Retry: ${diagnostic.retry}`);
  };

  lines.push("");
  lines.push(muted("Gateway connection details:"));
  for (const line of redactStatusSecrets(params.connectionDetailsForReport)
    .split("\n")
    .map((l) => l.trimEnd())) {
    emitDetail(line);
  }

  lines.push("");
  if (params.snap) {
    const status = !params.snap.exists ? "fail" : params.snap.valid ? "ok" : "warn";
    emitCheck(`Config: ${params.snap.path ?? "(unknown)"}`, status);
    // Length-prefix the path to keep arbitrary path/message pairs distinct.
    const uniqueIssues = dedupeByKey(
      [...(params.snap.legacyIssues ?? []), ...(params.snap.issues ?? [])],
      (issue) => `${issue.path.length}:${issue.path}${issue.message}`,
    );
    emitLimited(uniqueIssues, 12, (issue) => `  ${formatConfigIssueLine(issue, "-")}`);
  } else {
    emitCheck("Config: read failed", "warn");
  }

  if (params.remoteUrlMissing) {
    lines.push("");
    emitCheck("Gateway remote mode misconfigured (gateway.remote.url missing)", "warn");
    emitDetail("Fix: set gateway.remote.url, or set gateway.mode=local.");
  }

  emitCheck(
    `Secret diagnostics (${params.secretDiagnostics.length})`,
    params.secretDiagnostics.length === 0 ? "ok" : "warn",
  );
  emitLimited(
    params.secretDiagnostics,
    10,
    (diagnostic) => `  - ${muted(redactStatusSecrets(diagnostic))}`,
  );

  if (params.sentinel?.payload) {
    emitCheck("Restart sentinel present", "warn");
    emitDetail(
      `${summarizeRestartSentinel(params.sentinel.payload)} · ${formatTimeAgo(Date.now() - params.sentinel.payload.ts)}`,
    );
    const updateRestartValue = formatUpdateRestartStatusValue(params.sentinel.payload, {
      localGatewayHealthy: params.localGatewayHealthy,
      gatewayServer: params.gatewayServer,
    });
    if (updateRestartValue) {
      emitDetail(`Update restart: ${updateRestartValue}`);
    }
    for (const line of formatUpdateRestartActionLines(params.sentinel.payload)) {
      emitDetail(line);
    }
  } else {
    emitCheck("Restart sentinel: none", "ok");
  }

  const lastErrClean = normalizeOptionalString(params.lastErr) ?? "";
  // Restart logs sometimes end with a single brace from truncated JSON; suppress that noise.
  const isTrivialLastErr = lastErrClean.length < 8;
  if (lastErrClean && !isTrivialLastErr) {
    lines.push("");
    lines.push(muted("Recent Gateway log error (may be from an earlier run):"));
    emitDetail(redactStatusSecrets(lastErrClean));
  }

  if (params.portUsage) {
    const benignDualStackLoopback = isDualStackLoopbackGatewayListeners(
      params.portUsage.listeners,
      params.port,
    );
    const expectedGatewayListeners = isExpectedGatewayListeners(
      params.portUsage.listeners,
      params.port,
    );
    const portOk =
      params.portUsage.status === "free" ||
      (params.portUsage.status === "busy" && expectedGatewayListeners);
    emitCheck(`Port ${params.port}`, portOk ? "ok" : "warn");
    if (!portOk) {
      const gatewayPidCount = countGatewayListenerPids(params.portUsage);
      if (gatewayPidCount > 1) {
        emitDetail(
          `${gatewayPidCount} OpenClaw gateway processes appear to be listening on port ${params.port}; stop stale gateway processes before trusting channel health.`,
        );
      }
      for (const line of formatPortDiagnostics(params.portUsage)) {
        emitDetail(line);
      }
    } else if (benignDualStackLoopback) {
      emitDetail(
        "Detected dual-stack loopback listeners (127.0.0.1 + ::1) for one gateway process.",
      );
    } else if (expectedGatewayListeners) {
      emitDetail("Detected OpenClaw Gateway listener on the configured port.");
    }
  }

  emitCheck(
    `Tailscale exposure: ${params.tailscaleMode} · daemon unknown${params.tailscaleDns ? ` · ${params.tailscaleDns}` : ""}`,
    params.tailscaleMode === "off" ? "ok" : "warn",
  );
  if (params.tailscaleHttpsUrl) {
    emitDetail(`https: ${params.tailscaleHttpsUrl}`);
  }

  if (params.skillReadiness) {
    const { eligible, missing, workspaceDir } = params.skillReadiness;
    emitCheck(
      `Skills: ${eligible} eligible · ${missing} missing · ${workspaceDir}`,
      missing === 0 ? "ok" : "warn",
    );
  }

  emitCheck(
    `Plugin compatibility (${params.pluginCompatibility.length || "none"})`,
    params.pluginCompatibility.length === 0 ? "ok" : "warn",
  );
  emitLimited(params.pluginCompatibility, 12, (notice) => {
    const severity = notice.severity === "warn" ? "warn" : "info";
    return `  - [${severity}] ${formatPluginCompatibilityNotice(notice)}`;
  });

  if (params.agentStatus) {
    const recentSessions = countActiveStatusAgents({
      agentStatus: params.agentStatus,
      activeThresholdMs: AGENT_ACTIVITY_SOFT_WARNING_MS,
    });
    const hasKnownSessions = params.agentStatus.totalSessions > 0;
    const shouldWarn = hasKnownSessions && recentSessions === 0;
    emitCheck(
      `Agent activity: ${recentSessions} active in 30m · ${params.agentStatus.totalSessions} sessions`,
      shouldWarn ? "warn" : "ok",
    );
    if (shouldWarn) {
      emitDetail(
        "No agent session was updated in the last 30m; if channels received messages, verify inbound dispatch and turn creation.",
      );
    }
  }

  if (!params.nodeOnlyGateway && params.exporterDiagnostics) {
    if (params.exporterDiagnostics.ok) {
      const exporterSummary = formatTelemetryExporterSummary(params.exporterDiagnostics.value);
      if (exporterSummary) {
        emitCheck(exporterSummary.title, exporterSummary.status);
        for (const line of exporterSummary.lines) {
          emitDetail(line);
        }
      }
    } else {
      emitUnavailableDiagnostics({
        label: "Telemetry exporters",
        detail: `Exporter diagnostics failed: ${params.exporterDiagnostics.error}`,
        retry: "openclaw gateway stability --type telemetry.exporter",
      });
    }
  }

  if (!params.nodeOnlyGateway && params.deliveryDiagnostics) {
    const diagnostic = params.deliveryDiagnostics;
    if (!diagnostic.ok || !isDeliveryDiagnosticsLike(diagnostic.value)) {
      emitUnavailableDiagnostics({
        label: "Inbound delivery telemetry",
        detail: diagnostic.ok
          ? "Delivery diagnostics returned an invalid response."
          : `Delivery diagnostics failed: ${diagnostic.error}`,
        retry: "openclaw gateway stability",
      });
    } else {
      const deliveryDiagnostics = diagnostic.value;
      const received = countDeliveryEvent(deliveryDiagnostics, "message.received");
      const dispatchStarted = countDeliveryEvent(deliveryDiagnostics, "message.dispatch.started");
      const dispatchCompleted = countDeliveryEvent(
        deliveryDiagnostics,
        "message.dispatch.completed",
      );
      const turnsCreated = countDeliveryEvent(deliveryDiagnostics, "session.turn.created");
      const processed = countDeliveryEvent(deliveryDiagnostics, "message.processed");
      const hasReceivedWithoutDispatch = received > 0 && dispatchStarted === 0 && processed === 0;
      const hasDispatchWithoutTurn =
        dispatchStarted > 0 && turnsCreated === 0 && processed < dispatchStarted;
      const dispatchGap = dispatchStarted - dispatchCompleted;
      const hasDispatchGap = dispatchGap >= 2;
      const latestAgeMs = latestDeliveryEventAgeMs(deliveryDiagnostics);
      emitCheck(
        `Inbound delivery telemetry: received ${received} · dispatch ${dispatchStarted}/${dispatchCompleted} · turns ${turnsCreated} · processed ${processed}`,
        hasReceivedWithoutDispatch || hasDispatchWithoutTurn || hasDispatchGap ? "warn" : "ok",
      );
      if (latestAgeMs != null) {
        emitDetail(`latest delivery event: ${formatTimeAgo(latestAgeMs)}`);
      }
      if (hasReceivedWithoutDispatch) {
        emitDetail(
          "Messages were received, but no gateway dispatch started; inspect inbound routing and dispatch handoff.",
        );
      }
      if (hasDispatchWithoutTurn) {
        emitDetail(
          "Gateway dispatch started, but no agent turn was created; inspect reply resolver and session creation.",
        );
      }
      if (hasDispatchGap) {
        emitDetail(
          "Multiple gateway dispatches have not completed yet; if this persists, inspect stuck sessions or model runs.",
        );
      }
    }
  }

  params.progress.setLabel("Reading logs…");
  const logPaths = (() => {
    try {
      // macOS supervised installs write stdout/stderr differently than node-managed gateway logs.
      return process.platform === "darwin"
        ? resolveGatewaySupervisorLogPaths(process.env)
        : resolveGatewayLogPaths(process.env);
    } catch {
      return null;
    }
  })();
  if (logPaths) {
    params.progress.setLabel("Reading logs…");
    const restartLogPath = resolveGatewayRestartLogPath(process.env);
    const readStderr = process.platform !== "darwin";
    const [stderrTail, stdoutTail, restartTail] = await Promise.all([
      readStderr ? readFileTailLines(logPaths.stderrPath, 40).catch(() => []) : [],
      readFileTailLines(logPaths.stdoutPath, 40).catch(() => []),
      readFileTailLines(restartLogPath, 30).catch(() => []),
    ]);
    if (stderrTail.length > 0 || stdoutTail.length > 0) {
      lines.push("");
      lines.push(muted(`Gateway logs (tail, summarized): ${logPaths.logDir}`));
      for (const [stream, filePath, tail] of [
        ...(readStderr ? [["stderr", logPaths.stderrPath, stderrTail] as const] : []),
        ["stdout", logPaths.stdoutPath, stdoutTail] as const,
      ]) {
        emitDetail(`# ${stream}: ${filePath}`);
        for (const line of summarizeLogTail(tail, { maxLines: 22 }).map(redactStatusSecrets)) {
          emitDetail(line);
        }
      }
    }
    if (restartTail.length > 0) {
      lines.push("");
      lines.push(muted(`Gateway restart attempts (tail): ${restartLogPath}`));
      for (const line of summarizeLogTail(restartTail, { maxLines: 16 }).map(redactStatusSecrets)) {
        emitDetail(line);
      }
    }
  }
  params.progress.tick();

  if (params.channelsStatus) {
    emitCheck(
      `Channel issues (${params.channelIssues.length || "none"})`,
      params.channelIssues.length === 0 ? "ok" : "warn",
    );
    emitLimited(params.channelIssues, 12, (issue) => {
      const fixText = issue.fix ? ` · fix: ${issue.fix}` : "";
      return `  - ${issue.channel}[${issue.accountId}] ${issue.kind}: ${issue.message}${fixText}`;
    });
  } else if (params.nodeOnlyGateway) {
    emitCheck(
      `Channel issues skipped (node-only mode; query ${params.nodeOnlyGateway.gatewayTarget})`,
      "ok",
    );
  } else if (params.gatewayStartupPhase) {
    emitCheck(
      `Channel issues skipped (gateway still starting (phase ${params.gatewayStartupPhase}))`,
      "ok",
    );
  } else {
    emitCheck(
      `Channel issues skipped (gateway ${params.gatewayReachable ? "query failed" : "unreachable"})`,
      "warn",
    );
  }

  if (params.health) {
    if ("error" in params.health) {
      if (params.health.error) {
        lines.push("");
        lines.push(muted("Gateway health:"));
        emitDetail(redactStatusSecrets(params.health.error));
      }
    } else {
      const deliveryQueueLine = formatDeliveryQueueHealthLine(params.health);
      if (deliveryQueueLine) {
        emitCheck(redactStatusSecrets(deliveryQueueLine), "warn");
      }
    }
  }

  lines.push("");
  lines.push(muted("Pasteable debug report. Auth tokens redacted."));
  lines.push("Troubleshooting: https://docs.openclaw.ai/troubleshooting");
  lines.push("");
}
