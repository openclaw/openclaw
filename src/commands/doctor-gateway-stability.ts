import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGatewayLeastPrivilege } from "../gateway/call.js";
import { readLatestDiagnosticStabilityBundleSync } from "../logging/diagnostic-stability-bundle.js";
import type { DiagnosticStabilitySnapshot } from "../logging/diagnostic-stability.js";
import {
  formatChannelTurnLatencyMetrics,
  formatChannelTurnLatencyMs,
} from "./channel-turn-latency-format.js";

type ChannelTurnSummary = NonNullable<DiagnosticStabilitySnapshot["summary"]["channelTurns"]>;

export type GatewayChannelTurnHealthDoctorNote = {
  title: "Gateway channel turns";
  body: string;
};

function formatChannelTurnIssueLine(issue: ChannelTurnSummary["health"]["issues"][number]): string {
  const parts = [`- ${issue.level}: ${issue.code}`];
  if (typeof issue.count === "number") {
    parts.push(`count=${issue.count}`);
  }
  if (issue.metric) {
    parts.push(`${issue.metric}=${formatChannelTurnLatencyMs(issue.valueMs)}`);
  }
  return parts.join(" ");
}

function formatChannelTurnLatencyLine(latency: ChannelTurnSummary["latency"]): string | null {
  if (!latency) {
    return null;
  }
  const parts = formatChannelTurnLatencyMetrics(latency, { assign: "=", separator: " " });
  if (parts.length === 0) {
    return null;
  }
  return `Latency: ${parts.join("; ")}.`;
}

export function buildGatewayChannelTurnHealthDoctorNote(params: {
  snapshot: DiagnosticStabilitySnapshot;
  sourceLabel?: string;
}): GatewayChannelTurnHealthDoctorNote | null {
  const channelTurns = params.snapshot.summary.channelTurns;
  if (!channelTurns || channelTurns.health.status === "ok") {
    return null;
  }

  const source = params.sourceLabel?.trim() || "Gateway diagnostics";
  const lines = [
    `Channel turn health is ${channelTurns.health.status} from ${source}.`,
    `Delivery required=${channelTurns.deliveryRequired}, sent=${channelTurns.deliverySent}, failed=${channelTurns.deliveryFailed}, missing=${channelTurns.missingVisibleDelivery}.`,
  ];

  const latencyLine = formatChannelTurnLatencyLine(channelTurns.latency);
  if (latencyLine) {
    lines.push(latencyLine);
  }
  if (channelTurns.latency?.bottleneck) {
    lines.push(
      `Latency bottleneck: phase=${channelTurns.latency.bottleneck.phase}, metric=${
        channelTurns.latency.bottleneck.metric
      }, max=${formatChannelTurnLatencyMs(channelTurns.latency.bottleneck.maxMs)}, slow=${
        channelTurns.latency.bottleneck.slowCount
      }/${channelTurns.latency.bottleneck.count}.`,
    );
  }

  if (channelTurns.tools && (channelTurns.tools.called > 0 || channelTurns.tools.results > 0)) {
    lines.push(
      `Tools: called=${channelTurns.tools.called}, results=${channelTurns.tools.results}, failed=${channelTurns.tools.failedResults}, missing=${channelTurns.tools.missingResults}, slow=${channelTurns.tools.slowResults}.`,
    );
    const topTools = Object.entries(channelTurns.tools.byTool)
      .toSorted((a, b) => {
        const failureDelta =
          b[1].failedResults + b[1].missingResults - (a[1].failedResults + a[1].missingResults);
        if (failureDelta !== 0) {
          return failureDelta;
        }
        return (b[1].maxDurationMs ?? 0) - (a[1].maxDurationMs ?? 0);
      })
      .slice(0, 3);
    if (topTools.length > 0) {
      lines.push(
        `Top tools: ${topTools
          .map(
            ([toolName, counts]) =>
              `${toolName}(failed=${counts.failedResults}, missing=${
                counts.missingResults
              }, max=${formatChannelTurnLatencyMs(counts.maxDurationMs)})`,
          )
          .join("; ")}.`,
      );
    }
  }

  for (const issue of channelTurns.health.issues.slice(0, 5)) {
    lines.push(formatChannelTurnIssueLine(issue));
    lines.push(`  Guidance: ${issue.guidance}`);
  }

  const recentSlow = channelTurns.latency?.recentSlow.slice(-3).reverse() ?? [];
  if (recentSlow.length > 0) {
    lines.push("Recent slow turns:");
    for (const slow of recentSlow) {
      const details = [
        `seq=${slow.seq}`,
        slow.channel ? `channel=${slow.channel}` : "",
        slow.metric ? `${slow.metric}=${formatChannelTurnLatencyMs(slow.valueMs)}` : "",
        slow.turnId ? `turn=${slow.turnId}` : "",
      ].filter(Boolean);
      lines.push(`- ${details.join(" ")}`);
    }
  }

  const recentFailures = channelTurns.recentFailures.slice(-3).reverse();
  if (recentFailures.length > 0) {
    lines.push("Recent failures:");
    for (const failure of recentFailures) {
      const details = [
        `seq=${failure.seq}`,
        failure.channel ? `channel=${failure.channel}` : "",
        failure.reason ? `reason=${failure.reason}` : "",
        failure.turnId ? `turn=${failure.turnId}` : "",
      ].filter(Boolean);
      lines.push(`- ${details.join(" ")}`);
    }
  }

  return {
    title: "Gateway channel turns",
    body: lines.join("\n"),
  };
}

async function loadGatewayStabilitySnapshot(params: {
  cfg: OpenClawConfig;
  timeoutMs?: number;
  gatewayHealthy: boolean;
}): Promise<{ snapshot: DiagnosticStabilitySnapshot; sourceLabel: string } | null> {
  if (params.gatewayHealthy) {
    try {
      const snapshot = await callGatewayLeastPrivilege<DiagnosticStabilitySnapshot>({
        method: "diagnostics.stability",
        params: { limit: 1000 },
        timeoutMs: params.timeoutMs,
        config: params.cfg,
      });
      return { snapshot, sourceLabel: "live Gateway diagnostics" };
    } catch {
      // Fall through to the persisted bundle path. Doctor should not become
      // noisy just because the live stability lane was unavailable.
    }
  }

  const latest = readLatestDiagnosticStabilityBundleSync();
  if (latest.status !== "found") {
    return null;
  }
  return {
    snapshot: latest.bundle.snapshot,
    sourceLabel: `latest stability bundle (${latest.bundle.generatedAt})`,
  };
}

export async function noteGatewayChannelTurnHealth(params: {
  cfg: OpenClawConfig;
  timeoutMs?: number;
  gatewayHealthy?: boolean;
}): Promise<void> {
  const loaded = await loadGatewayStabilitySnapshot({
    cfg: params.cfg,
    timeoutMs: params.timeoutMs,
    gatewayHealthy: params.gatewayHealthy === true,
  });
  if (!loaded) {
    return;
  }

  const healthNote = buildGatewayChannelTurnHealthDoctorNote(loaded);
  if (!healthNote) {
    return;
  }
  note(healthNote.body, healthNote.title);
}
