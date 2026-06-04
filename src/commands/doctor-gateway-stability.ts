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
  title:
    | "Gateway channel turns"
    | "Gateway sessions"
    | "Gateway queues"
    | "Gateway runtime recommendations";
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

function formatTopCountMap(values: Record<string, number>, limit = 5): string | null {
  const formatted = Object.entries(values)
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => `${key}=${count}`)
    .join(", ");
  return formatted || null;
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
      `Tools: called=${channelTurns.tools.called}, results=${channelTurns.tools.results}, failed=${channelTurns.tools.failedResults}, missing=${channelTurns.tools.missingResults}, slow=${channelTurns.tools.slowResults}, preDelivery=${channelTurns.tools.preDeliveryCalls}, slowPreDelivery=${channelTurns.tools.slowPreDeliveryResults}.`,
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
              }, preDelivery=${counts.preDeliveryCalls}, max=${formatChannelTurnLatencyMs(
                counts.maxDurationMs,
              )})`,
          )
          .join("; ")}.`,
      );
    }
    const recentPreDeliverySlow = channelTurns.tools.recentPreDeliverySlow.slice(-3).toReversed();
    if (recentPreDeliverySlow.length > 0) {
      lines.push("Recent slow pre-delivery tools:");
      for (const slow of recentPreDeliverySlow) {
        const details = [
          `seq=${slow.seq}`,
          slow.channel ? `channel=${slow.channel}` : "",
          slow.toolName ? `tool=${slow.toolName}` : "",
          `duration=${formatChannelTurnLatencyMs(slow.durationMs)}`,
          slow.turnId ? `turn=${slow.turnId}` : "",
        ].filter(Boolean);
        lines.push(`- ${details.join(" ")}`);
      }
    }
  }

  for (const issue of channelTurns.health.issues.slice(0, 5)) {
    lines.push(formatChannelTurnIssueLine(issue));
    lines.push(`  Guidance: ${issue.guidance}`);
  }

  const recentSlow = channelTurns.latency?.recentSlow.slice(-3).toReversed() ?? [];
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

  const recentFailures = channelTurns.recentFailures.slice(-3).toReversed();
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

export function buildGatewaySessionAttentionDoctorNote(params: {
  snapshot: DiagnosticStabilitySnapshot;
  sourceLabel?: string;
}): GatewayChannelTurnHealthDoctorNote | null {
  const attention = params.snapshot.summary.sessions?.attention;
  if (!attention) {
    return null;
  }
  const totalAttention =
    attention.longRunning +
    attention.stalled +
    attention.stuck +
    attention.recoveryRequested +
    attention.recoveryCompleted;
  if (totalAttention <= 0) {
    return null;
  }

  const source = params.sourceLabel?.trim() || "Gateway diagnostics";
  const lines = [
    `Session attention is active from ${source}.`,
    `Counts: longRunning=${attention.longRunning}, stalled=${attention.stalled}, stuck=${attention.stuck}, recoveryRequested=${attention.recoveryRequested}, recoveryCompleted=${attention.recoveryCompleted}.`,
  ];

  const classifications = formatTopCountMap(attention.byClassification);
  if (classifications) {
    lines.push(`Classifications: ${classifications}.`);
  }
  const activeWork = formatTopCountMap(attention.byActiveWorkKind);
  if (activeWork) {
    lines.push(`Active work: ${activeWork}.`);
  }

  const recent = attention.recent.slice(-5).toReversed();
  if (recent.length > 0) {
    lines.push("Recent session attention:");
    for (const event of recent) {
      const details = [
        `seq=${event.seq}`,
        event.type,
        event.classification ? `classification=${event.classification}` : "",
        event.reason ? `reason=${event.reason}` : "",
        event.activeWorkKind ? `activeWork=${event.activeWorkKind}` : "",
        event.toolName ? `tool=${event.toolName}` : "",
        event.ageMs !== undefined ? `age=${formatChannelTurnLatencyMs(event.ageMs)}` : "",
        event.queueDepth !== undefined ? `queueDepth=${event.queueDepth}` : "",
      ].filter(Boolean);
      lines.push(`- ${details.join(" ")}`);
    }
  }

  lines.push(
    "Guidance: inspect the active tool/run and use official cancel, recovery, or TaskFlow handoff paths before adding prompt-only rules.",
  );

  return {
    title: "Gateway sessions",
    body: lines.join("\n"),
  };
}

export function buildGatewayQueueHealthDoctorNote(params: {
  snapshot: DiagnosticStabilitySnapshot;
  sourceLabel?: string;
}): GatewayChannelTurnHealthDoctorNote | null {
  const queues = params.snapshot.summary.queues;
  if (!queues) {
    return null;
  }
  const hasSlowWaits = queues.slowDequeues > 0;
  const hasLargeQueue = (queues.maxQueueSize ?? 0) >= 5;
  if (!hasSlowWaits && !hasLargeQueue) {
    return null;
  }

  const source = params.sourceLabel?.trim() || "Gateway diagnostics";
  const lines = [
    `Queue health needs attention from ${source}.`,
    `Counts: enqueued=${queues.enqueued}, dequeued=${queues.dequeued}, slow=${queues.slowDequeues}, maxWait=${formatChannelTurnLatencyMs(
      queues.maxWaitMs,
    )}, maxQueue=${queues.maxQueueSize ?? "unknown"}.`,
  ];

  const topLanes = Object.entries(queues.byLane)
    .toSorted((a, b) => {
      const slowDelta = b[1].slowDequeues - a[1].slowDequeues;
      if (slowDelta !== 0) {
        return slowDelta;
      }
      return (b[1].maxWaitMs ?? 0) - (a[1].maxWaitMs ?? 0);
    })
    .slice(0, 5);
  if (topLanes.length > 0) {
    lines.push(
      `Lanes: ${topLanes
        .map(
          ([lane, summary]) =>
            `${lane}(enq=${summary.enqueued}, deq=${summary.dequeued}, slow=${
              summary.slowDequeues
            }, maxWait=${formatChannelTurnLatencyMs(summary.maxWaitMs)}, maxQueue=${
              summary.maxQueueSize ?? "unknown"
            })`,
        )
        .join("; ")}.`,
    );
  }

  const recentSlow = queues.recentSlow.slice(-5).toReversed();
  if (recentSlow.length > 0) {
    lines.push("Recent slow queue waits:");
    for (const slow of recentSlow) {
      const details = [
        `seq=${slow.seq}`,
        `lane=${slow.lane}`,
        `wait=${formatChannelTurnLatencyMs(slow.waitMs)}`,
        slow.queueSize !== undefined ? `queueSize=${slow.queueSize}` : "",
      ].filter(Boolean);
      lines.push(`- ${details.join(" ")}`);
    }
  }

  lines.push(
    "Guidance: inspect lane pressure and background work; direct-control lanes should not wait behind long tool or cron work.",
  );

  return {
    title: "Gateway queues",
    body: lines.join("\n"),
  };
}

export function buildGatewayRuntimeRecommendationsDoctorNote(params: {
  snapshot: DiagnosticStabilitySnapshot;
  sourceLabel?: string;
}): GatewayChannelTurnHealthDoctorNote | null {
  const recommendations = params.snapshot.summary.recommendations;
  if (!recommendations || recommendations.length === 0) {
    return null;
  }

  const source = params.sourceLabel?.trim() || "Gateway diagnostics";
  const lines = [`Runtime recommendations from ${source}:`];
  for (const recommendation of recommendations.slice(0, 5)) {
    const details = [
      `${recommendation.priority}: ${recommendation.code}`,
      `source=${recommendation.source}`,
      `reason=${recommendation.reason}`,
      recommendation.metric ? `metric=${recommendation.metric}` : "",
      recommendation.valueMs !== undefined
        ? `value=${formatChannelTurnLatencyMs(recommendation.valueMs)}`
        : "",
      recommendation.count !== undefined ? `count=${recommendation.count}` : "",
    ].filter(Boolean);
    lines.push(`- ${details.join(" ")}`);
    lines.push(`  Guidance: ${recommendation.guidance}`);
  }

  return {
    title: "Gateway runtime recommendations",
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
  if (healthNote) {
    note(healthNote.body, healthNote.title);
  }
  const sessionNote = buildGatewaySessionAttentionDoctorNote(loaded);
  if (sessionNote) {
    note(sessionNote.body, sessionNote.title);
  }
  const queueNote = buildGatewayQueueHealthDoctorNote(loaded);
  if (queueNote) {
    note(queueNote.body, queueNote.title);
  }
  const recommendationsNote = buildGatewayRuntimeRecommendationsDoctorNote(loaded);
  if (recommendationsNote) {
    note(recommendationsNote.body, recommendationsNote.title);
  }
}
