import { colorize, theme } from "../../../packages/terminal-core/src/theme.js";

export type LaneDiagnosticsPayload = {
  ts?: number;
  lanes?: Array<{
    lane: string;
    queuedCount: number;
    activeCount: number;
    maxConcurrent: number;
    draining?: boolean;
    blockedBy?: string | null;
    group?: string;
    groupActive?: number;
    groupBudget?: number;
    concurrencyScope?: string;
    saturatedLaneCount?: number;
  }>;
  dynamic?: {
    laneCount: number;
    activeCount: number;
    queuedCount: number;
    queuedLaneCount: number;
  } | null;
  workerCount?: number;
  workerPoolCount?: number;
};

export function renderLanesSummary(payload: unknown, rich: boolean): string[] {
  const snapshot =
    payload && typeof payload === "object" ? (payload as LaneDiagnosticsPayload) : {};
  const lines = [colorize(rich, theme.heading, "Gateway Lanes")];
  if (typeof snapshot.ts === "number") {
    lines.push(`${colorize(rich, theme.muted, "Ts:")} ${snapshot.ts}`);
  }
  const lanes = Array.isArray(snapshot.lanes) ? snapshot.lanes : [];
  if (lanes.length === 0) {
    lines.push(colorize(rich, theme.muted, "No lanes reported."));
  } else {
    for (const lane of lanes) {
      const parts = [
        `active=${lane.activeCount}`,
        `queued=${lane.queuedCount}`,
        `max=${lane.maxConcurrent}`,
      ];
      if (lane.draining) {
        parts.push("draining");
      }
      if (lane.blockedBy) {
        parts.push(`blockedBy=${lane.blockedBy}`);
      }
      if (lane.group) {
        parts.push(
          `group=${lane.group}` +
            (lane.groupActive !== undefined && lane.groupBudget !== undefined
              ? `(${lane.groupActive}/${lane.groupBudget})`
              : ""),
        );
      }
      if (lane.concurrencyScope) {
        parts.push(`scope=${lane.concurrencyScope}`);
      }
      if (lane.saturatedLaneCount !== undefined && lane.saturatedLaneCount > 0) {
        parts.push(`saturated=${lane.saturatedLaneCount}`);
      }
      lines.push(`${colorize(rich, theme.muted, `${lane.lane}:`)} ${parts.join(" · ")}`);
    }
  }
  if (snapshot.dynamic) {
    lines.push(
      `${colorize(rich, theme.muted, "Dynamic:")} lanes=${snapshot.dynamic.laneCount} · active=${snapshot.dynamic.activeCount} · queued=${snapshot.dynamic.queuedCount} · queuedLanes=${snapshot.dynamic.queuedLaneCount}`,
    );
  }
  if (typeof snapshot.workerCount === "number" || typeof snapshot.workerPoolCount === "number") {
    lines.push(
      `${colorize(rich, theme.muted, "Workers:")} count=${snapshot.workerCount ?? 0} · pools=${snapshot.workerPoolCount ?? 0}`,
    );
  }
  return lines;
}
