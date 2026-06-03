import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGatewayLeastPrivilege } from "../gateway/call.js";
import { readLatestDiagnosticStabilityBundleSync } from "../logging/diagnostic-stability-bundle.js";
import type { DiagnosticStabilitySnapshot } from "../logging/diagnostic-stability.js";

type ChannelTurnSummary = NonNullable<DiagnosticStabilitySnapshot["summary"]["channelTurns"]>;

export type GatewayChannelTurnHealthDoctorNote = {
  title: "Gateway channel turns";
  body: string;
};

function formatMilliseconds(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown";
  }
  return `${Math.round(value)}ms`;
}

function formatChannelTurnIssueLine(issue: ChannelTurnSummary["health"]["issues"][number]): string {
  const parts = [`- ${issue.level}: ${issue.code}`];
  if (typeof issue.count === "number") {
    parts.push(`count=${issue.count}`);
  }
  if (issue.metric) {
    parts.push(`${issue.metric}=${formatMilliseconds(issue.valueMs)}`);
  }
  return parts.join(" ");
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

  for (const issue of channelTurns.health.issues.slice(0, 5)) {
    lines.push(formatChannelTurnIssueLine(issue));
    lines.push(`  Guidance: ${issue.guidance}`);
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
