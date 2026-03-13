import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import { formatTokenCount } from "../utils/usage-format.js";
import { formatContextUsageLine } from "./tui-formatters.js";
import type { GatewayStatusSummary } from "./tui-types.js";

export function formatStatusSummary(summary: GatewayStatusSummary) {
  const lines: string[] = [];
  lines.push("Gateway status");
  if (summary.runtimeVersion) {
    lines.push(`Version: ${summary.runtimeVersion}`);
  }

  if (!summary.linkChannel) {
    lines.push("Link channel: unknown");
  } else {
    const linkLabel = summary.linkChannel.label ?? "Link channel";
    const linked = summary.linkChannel.linked === true;
    const authAge =
      linked && typeof summary.linkChannel.authAgeMs === "number"
        ? ` (last refreshed ${formatTimeAgo(summary.linkChannel.authAgeMs)})`
        : "";
    lines.push(`${linkLabel}: ${linked ? "linked" : "not linked"}${authAge}`);
  }

  const providerSummary = Array.isArray(summary.providerSummary) ? summary.providerSummary : [];
  if (providerSummary.length > 0) {
    lines.push("");
    lines.push("System:");
    for (const line of providerSummary) {
      lines.push(`  ${line}`);
    }
  }

  const heartbeatAgents = summary.heartbeat?.agents ?? [];
  if (heartbeatAgents.length > 0) {
    const heartbeatParts = heartbeatAgents.map((agent) => {
      const agentId = agent.agentId ?? "unknown";
      if (!agent.enabled || !agent.everyMs) {
        return `disabled (${agentId})`;
      }
      return `${agent.every ?? "unknown"} (${agentId})`;
    });
    lines.push("");
    lines.push(`Heartbeat: ${heartbeatParts.join(", ")}`);
  }

  const dominantLatency = summary.heartbeat?.diagnostics?.latency?.dominant?.[0];
  const earlyStatusGuidance = summary.heartbeat?.diagnostics?.earlyStatus?.guidance;
  const phase2Supplements = summary.heartbeat?.diagnostics?.earlyStatus?.phase2Supplements;
  if (dominantLatency || earlyStatusGuidance || phase2Supplements) {
    lines.push("");
    lines.push("Early status:");
    if (dominantLatency) {
      lines.push(`  Dominant latency: ${dominantLatency.segment} x${dominantLatency.count ?? 0}`);
    }
    if (phase2Supplements) {
      const supplementLine = [
        `Phase-2 supplements: ${phase2Supplements.eligibleCount ?? 0}/${phase2Supplements.sampleCount ?? 0} (${phase2Supplements.hitRatePct ?? 0}%)`,
        typeof phase2Supplements.statusFirstVisibleAvgMs === "number"
          ? `status visible ${phase2Supplements.statusFirstVisibleAvgMs}/${phase2Supplements.statusFirstVisibleP95Ms ?? phase2Supplements.statusFirstVisibleAvgMs}ms`
          : null,
      ]
        .filter(Boolean)
        .join(" | ");
      lines.push(`  ${supplementLine}`);
      const topSkip = phase2Supplements.topSkipReasons?.[0];
      if (topSkip?.reason) {
        lines.push(`  Top skip: ${topSkip.reason} x${topSkip.count ?? 0}`);
      }
    }
    if (earlyStatusGuidance?.focus) {
      lines.push(`  Next: ${earlyStatusGuidance.focus} | ${earlyStatusGuidance.reason ?? ""}`);
    }
  }

  const sessionPaths = summary.sessions?.paths ?? [];
  if (sessionPaths.length === 1) {
    lines.push(`Session store: ${sessionPaths[0]}`);
  } else if (sessionPaths.length > 1) {
    lines.push(`Session stores: ${sessionPaths.length}`);
  }

  const defaults = summary.sessions?.defaults;
  const defaultModel = defaults?.model ?? "unknown";
  const defaultCtx =
    typeof defaults?.contextTokens === "number"
      ? ` (${formatTokenCount(defaults.contextTokens)} ctx)`
      : "";
  lines.push(`Default model: ${defaultModel}${defaultCtx}`);

  const sessionCount = summary.sessions?.count ?? 0;
  lines.push(`Active sessions: ${sessionCount}`);

  const recent = Array.isArray(summary.sessions?.recent) ? summary.sessions?.recent : [];
  if (recent.length > 0) {
    lines.push("Recent sessions:");
    for (const entry of recent) {
      const ageLabel = typeof entry.age === "number" ? formatTimeAgo(entry.age) : "no activity";
      const model = entry.model ?? "unknown";
      const usage = formatContextUsageLine({
        total: entry.totalTokens ?? null,
        context: entry.contextTokens ?? null,
        remaining: entry.remainingTokens ?? null,
        percent: entry.percentUsed ?? null,
      });
      const flags = entry.flags?.length ? ` | flags: ${entry.flags.join(", ")}` : "";
      lines.push(
        `- ${entry.key}${entry.kind ? ` [${entry.kind}]` : ""} | ${ageLabel} | model ${model} | ${usage}${flags}`,
      );
    }
  }

  const queued = Array.isArray(summary.queuedSystemEvents) ? summary.queuedSystemEvents : [];
  if (queued.length > 0) {
    const preview = queued.slice(0, 3).join(" | ");
    lines.push(`Queued system events (${queued.length}): ${preview}`);
  }

  return lines;
}
