import { formatCliCommand } from "../../cli/command-format.js";
import type { ProgressReporter } from "../../cli/progress.js";
import { formatConfigIssueLine } from "../../config/issue-format.js";
import { resolveGatewayLogPaths } from "../../daemon/launchd.js";
import {
  formatPortDiagnostics,
  isDualStackLoopbackGatewayListeners,
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
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { NodeOnlyGatewayInfo } from "../status.node-mode.js";
import { formatTimeAgo, redactSecrets } from "./format.js";
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

type TailscaleStatusLike = {
  backendState: string | null;
  dnsName: string | null;
  ips: string[];
  error: string | null;
};

type SkillStatusLike = {
  workspaceDir: string;
  skills: Array<{ eligible: boolean; missing: Record<string, unknown[]> }>;
};

type ChannelIssueLike = {
  channel: string;
  accountId: string;
  kind: string;
  message: string;
  fix?: string;
};

type RecoveryGuidance = {
  cause: string;
  fix: string;
};

function extractOAuthRefreshFailureProvider(message: string): string | null {
  const provider = message.match(/OAuth token refresh failed for ([^:]+):/i)?.[1]?.trim();
  return provider && provider.length > 0 ? provider : null;
}

function buildOAuthRefreshLoginCommand(provider: string | null): string {
  return provider
    ? formatCliCommand(`openclaw models auth login --provider ${provider}`)
    : formatCliCommand("openclaw models auth login");
}

function classifyGatewayLogRecovery(lastErr: string): RecoveryGuidance | null {
  const lower = (normalizeOptionalString(lastErr) ?? "").toLowerCase();
  if (!lower) {
    return null;
  }
  if (
    lower.includes("refusing to bind gateway") ||
    lower.includes("failed to bind gateway socket")
  ) {
    return {
      cause: "gateway startup is blocked by local port binding",
      fix: `Free the configured gateway port, or change it, then restart the gateway (${formatCliCommand("openclaw gateway restart")}) and rerun status.`,
    };
  }
  if (lower.includes("gateway auth mode")) {
    return {
      cause: "gateway auth configuration is invalid for the current mode",
      fix: "Check the gateway.auth settings in config, restart the gateway, then rerun status.",
    };
  }
  if (lower.includes("tailscale") && lower.includes("requires")) {
    return {
      cause: "the configured gateway path depends on Tailscale, but Tailscale is not ready",
      fix: "Start or repair Tailscale, or switch the gateway back to local mode, then rerun status.",
    };
  }
  if (lower.includes("gateway start blocked")) {
    return {
      cause: "gateway startup was blocked by a preflight check",
      fix: "Resolve the blocking condition above, restart the gateway, then rerun status.",
    };
  }
  return null;
}

function classifyGatewayHealthRecovery(params: {
  healthErr: string;
  gatewayReachable: boolean;
}): RecoveryGuidance | null {
  const clean = normalizeOptionalString(params.healthErr) ?? "";
  const lower = clean.toLowerCase();
  if (!lower) {
    return null;
  }

  const oauthProvider = extractOAuthRefreshFailureProvider(clean);
  if (/oauth token refresh failed/i.test(clean)) {
    return {
      cause: `provider auth refresh failed${oauthProvider ? ` (${oauthProvider})` : ""}`,
      fix: `Re-authenticate the affected provider via ${buildOAuthRefreshLoginCommand(oauthProvider)} and rerun status.`,
    };
  }

  if (
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {
    return {
      cause: "gateway health probing could not authenticate against the configured gateway",
      fix: "Verify the configured gateway token/password matches the running gateway, then rerun status.",
    };
  }

  if (
    lower.includes("gateway unreachable") ||
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("fetch failed") ||
    lower.includes("timed out")
  ) {
    return params.gatewayReachable
      ? {
          cause: "the gateway answered the reachability probe, but the health RPC still failed",
          fix: `Retry ${formatCliCommand("openclaw status --all")}; if it keeps failing, restart the gateway (${formatCliCommand("openclaw gateway restart")}) and rerun status.`,
        }
      : {
          cause: "the configured gateway target is not responding",
          fix: `Check whether the gateway is running with ${formatCliCommand("openclaw gateway status")}; if needed, start it with ${formatCliCommand("openclaw gateway start")}, then rerun status.`,
        };
  }

  return params.gatewayReachable
    ? {
        cause: "the gateway health probe failed for an uncategorized reason",
        fix: `Retry ${formatCliCommand("openclaw status --all")}; if it persists, inspect gateway logs and restart the gateway.`,
      }
    : null;
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
  tailscale: TailscaleStatusLike;
  tailscaleHttpsUrl: string | null;
  skillStatus: SkillStatusLike | null;
  pluginCompatibility: PluginCompatibilityNotice[];
  channelsStatus: unknown;
  channelIssues: ChannelIssueLike[];
  gatewayReachable: boolean;
  health: unknown;
  nodeOnlyGateway: NodeOnlyGatewayInfo | null;
}) {
  const { lines, muted, ok, warn, fail } = params;

  const emitCheck = (label: string, status: "ok" | "warn" | "fail") => {
    const icon = status === "ok" ? ok("✓") : status === "warn" ? warn("!") : fail("✗");
    const colored = status === "ok" ? ok(label) : status === "warn" ? warn(label) : fail(label);
    lines.push(`${icon} ${colored}`);
  };

  lines.push("");
  lines.push(muted("Gateway connection details:"));
  for (const line of redactSecrets(params.connectionDetailsForReport)
    .split("\n")
    .map((l) => l.trimEnd())) {
    lines.push(`  ${muted(line)}`);
  }

  lines.push("");
  if (params.snap) {
    const status = !params.snap.exists ? "fail" : params.snap.valid ? "ok" : "warn";
    emitCheck(`Config: ${params.snap.path ?? "(unknown)"}`, status);
    const issues = [...(params.snap.legacyIssues ?? []), ...(params.snap.issues ?? [])];
    const uniqueIssues = issues.filter(
      (issue, index) =>
        issues.findIndex((x) => x.path === issue.path && x.message === issue.message) === index,
    );
    for (const issue of uniqueIssues.slice(0, 12)) {
      lines.push(`  ${formatConfigIssueLine(issue, "-")}`);
    }
    if (uniqueIssues.length > 12) {
      lines.push(`  ${muted(`… +${uniqueIssues.length - 12} more`)}`);
    }
    if (!params.snap.exists) {
      lines.push(
        `  ${muted("Fix: create the config file or point OpenClaw at the intended config path, then rerun status.")}`,
      );
    } else if (!params.snap.valid && uniqueIssues.length > 0) {
      lines.push(
        `  ${muted("Fix: resolve the config issues above, save the config, then rerun status.")}`,
      );
    }
  } else {
    emitCheck("Config: read failed", "warn");
  }

  if (params.remoteUrlMissing) {
    lines.push("");
    emitCheck("Gateway remote mode misconfigured (gateway.remote.url missing)", "warn");
    lines.push(`  ${muted("Fix: set gateway.remote.url, or set gateway.mode=local.")}`);
  }

  emitCheck(
    `Secret diagnostics (${params.secretDiagnostics.length})`,
    params.secretDiagnostics.length === 0 ? "ok" : "warn",
  );
  for (const diagnostic of params.secretDiagnostics.slice(0, 10)) {
    lines.push(`  - ${muted(redactSecrets(diagnostic))}`);
  }
  if (params.secretDiagnostics.length > 10) {
    lines.push(`  ${muted(`… +${params.secretDiagnostics.length - 10} more`)}`);
  }

  if (params.sentinel?.payload) {
    emitCheck("Restart sentinel present", "warn");
    lines.push(
      `  ${muted(`${summarizeRestartSentinel(params.sentinel.payload)} · ${formatTimeAgo(Date.now() - params.sentinel.payload.ts)}`)}`,
    );
  } else {
    emitCheck("Restart sentinel: none", "ok");
  }

  const lastErrClean = normalizeOptionalString(params.lastErr) ?? "";
  const isTrivialLastErr = lastErrClean.length < 8 || lastErrClean === "}" || lastErrClean === "{";
  if (lastErrClean && !isTrivialLastErr) {
    lines.push("");
    lines.push(muted("Gateway last log line:"));
    lines.push(`  ${muted(redactSecrets(lastErrClean))}`);
    const recovery = classifyGatewayLogRecovery(lastErrClean);
    if (recovery) {
      lines.push(`  ${muted(`Cause: ${recovery.cause}.`)}`);
      lines.push(`  ${muted(`Fix: ${recovery.fix}`)}`);
    }
  }

  if (params.portUsage) {
    const benignDualStackLoopback = isDualStackLoopbackGatewayListeners(
      params.portUsage.listeners,
      params.port,
    );
    const portOk = params.portUsage.listeners.length === 0 || benignDualStackLoopback;
    emitCheck(`Port ${params.port}`, portOk ? "ok" : "warn");
    if (!portOk) {
      for (const line of formatPortDiagnostics(params.portUsage)) {
        lines.push(`  ${muted(line)}`);
      }
    } else if (benignDualStackLoopback) {
      lines.push(
        `  ${muted("Detected dual-stack loopback listeners (127.0.0.1 + ::1) for one gateway process.")}`,
      );
    }
  }

  {
    const backend = params.tailscale.backendState ?? "unknown";
    const okBackend = backend === "Running";
    const hasDns = Boolean(params.tailscale.dnsName);
    const label =
      params.tailscaleMode === "off"
        ? `Tailscale: off · ${backend}${params.tailscale.dnsName ? ` · ${params.tailscale.dnsName}` : ""}`
        : `Tailscale: ${params.tailscaleMode} · ${backend}${params.tailscale.dnsName ? ` · ${params.tailscale.dnsName}` : ""}`;
    emitCheck(label, okBackend && (params.tailscaleMode === "off" || hasDns) ? "ok" : "warn");
    if (params.tailscale.error) {
      lines.push(`  ${muted(`error: ${params.tailscale.error}`)}`);
    }
    if (params.tailscale.ips.length > 0) {
      lines.push(
        `  ${muted(`ips: ${params.tailscale.ips.slice(0, 3).join(", ")}${params.tailscale.ips.length > 3 ? "…" : ""}`)}`,
      );
    }
    if (params.tailscaleHttpsUrl) {
      lines.push(`  ${muted(`https: ${params.tailscaleHttpsUrl}`)}`);
    }
  }

  if (params.skillStatus) {
    const eligible = params.skillStatus.skills.filter((s) => s.eligible).length;
    const missing = params.skillStatus.skills.filter(
      (s) => s.eligible && Object.values(s.missing).some((arr) => arr.length),
    ).length;
    emitCheck(
      `Skills: ${eligible} eligible · ${missing} missing · ${params.skillStatus.workspaceDir}`,
      missing === 0 ? "ok" : "warn",
    );
  }

  emitCheck(
    `Plugin compatibility (${params.pluginCompatibility.length || "none"})`,
    params.pluginCompatibility.length === 0 ? "ok" : "warn",
  );
  for (const notice of params.pluginCompatibility.slice(0, 12)) {
    const severity = notice.severity === "warn" ? "warn" : "info";
    lines.push(`  - [${severity}] ${formatPluginCompatibilityNotice(notice)}`);
  }
  if (params.pluginCompatibility.length > 12) {
    lines.push(`  ${muted(`… +${params.pluginCompatibility.length - 12} more`)}`);
  }

  params.progress.setLabel("Reading logs…");
  const logPaths = (() => {
    try {
      return resolveGatewayLogPaths(process.env);
    } catch {
      return null;
    }
  })();
  if (logPaths) {
    params.progress.setLabel("Reading logs…");
    const [stderrTail, stdoutTail] = await Promise.all([
      readFileTailLines(logPaths.stderrPath, 40).catch(() => []),
      readFileTailLines(logPaths.stdoutPath, 40).catch(() => []),
    ]);
    if (stderrTail.length > 0 || stdoutTail.length > 0) {
      lines.push("");
      lines.push(muted(`Gateway logs (tail, summarized): ${logPaths.logDir}`));
      lines.push(`  ${muted(`# stderr: ${logPaths.stderrPath}`)}`);
      for (const line of summarizeLogTail(stderrTail, { maxLines: 22 }).map(redactSecrets)) {
        lines.push(`  ${muted(line)}`);
      }
      lines.push(`  ${muted(`# stdout: ${logPaths.stdoutPath}`)}`);
      for (const line of summarizeLogTail(stdoutTail, { maxLines: 22 }).map(redactSecrets)) {
        lines.push(`  ${muted(line)}`);
      }
    }
  }
  params.progress.tick();

  if (params.channelsStatus) {
    emitCheck(
      `Channel issues (${params.channelIssues.length || "none"})`,
      params.channelIssues.length === 0 ? "ok" : "warn",
    );
    for (const issue of params.channelIssues.slice(0, 12)) {
      const fixText = issue.fix ? ` · fix: ${issue.fix}` : "";
      lines.push(
        `  - ${issue.channel}[${issue.accountId}] ${issue.kind}: ${issue.message}${fixText}`,
      );
    }
    if (params.channelIssues.length > 12) {
      lines.push(`  ${muted(`… +${params.channelIssues.length - 12} more`)}`);
    }
  } else if (params.nodeOnlyGateway) {
    emitCheck(
      `Channel issues skipped (node-only mode; query ${params.nodeOnlyGateway.gatewayTarget})`,
      "ok",
    );
  } else {
    emitCheck(
      `Channel issues skipped (gateway ${params.gatewayReachable ? "query failed" : "unreachable"})`,
      "warn",
    );
    if (params.gatewayReachable) {
      lines.push(
        `  ${muted("Cause: the gateway answered the reachability probe, but channel-status inspection still failed.")}`,
      );
      lines.push(
        `  ${muted(`Fix: retry ${formatCliCommand("openclaw status --all")}; if it persists, restart the gateway (${formatCliCommand("openclaw gateway restart")}) and rerun status.`)}`,
      );
    } else {
      lines.push(`  ${muted("Cause: the configured gateway target is not responding.")}`);
      lines.push(
        `  ${muted(`Fix: check the gateway with ${formatCliCommand("openclaw gateway status")}; if needed, start it with ${formatCliCommand("openclaw gateway start")}, then rerun status.`)}`,
      );
    }
  }

  const healthErr = (() => {
    if (!params.health || typeof params.health !== "object") {
      return "";
    }
    const record = params.health as Record<string, unknown>;
    if (!("error" in record)) {
      return "";
    }
    const value = record.error;
    if (!value) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "[unserializable error]";
    }
  })();
  if (healthErr) {
    lines.push("");
    lines.push(muted("Gateway health:"));
    lines.push(`  ${muted(redactSecrets(healthErr))}`);
    const recovery = classifyGatewayHealthRecovery({
      healthErr,
      gatewayReachable: params.gatewayReachable,
    });
    if (recovery) {
      lines.push(`  ${muted(`Cause: ${recovery.cause}.`)}`);
      lines.push(`  ${muted(`Fix: ${recovery.fix}`)}`);
    }
  }

  lines.push("");
  lines.push(muted("Pasteable debug report. Auth tokens redacted."));
  lines.push("Troubleshooting: https://docs.openclaw.ai/troubleshooting");
  lines.push("");
}
