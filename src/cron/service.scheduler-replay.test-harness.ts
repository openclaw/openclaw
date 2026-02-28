import type { CronServiceState } from "./service/state.js";
import { ensureLoaded } from "./service/store.js";
import { onTimer, stopTimer } from "./service/timer.js";
import type { CronJob } from "./types.js";

export type SchedulerReplayStep = {
  at: string | number | Date;
  ticks?: number;
  label?: string;
};

export type SchedulerReplayJobSnapshot = {
  id: string;
  name: string;
  enabled: boolean;
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: string;
};

export type SchedulerReplayTickSnapshot = {
  label: string;
  atMs: number;
  tick: number;
  jobs: SchedulerReplayJobSnapshot[];
};

function resolveReplayAtMs(value: SchedulerReplayStep["at"]): number {
  if (typeof value === "number") {
    return value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  return Date.parse(value);
}

function snapshotJob(job: CronJob): SchedulerReplayJobSnapshot {
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled,
    nextRunAtMs: job.state.nextRunAtMs,
    runningAtMs: job.state.runningAtMs,
    lastRunAtMs: job.state.lastRunAtMs,
    lastStatus: job.state.lastStatus,
  };
}

export async function replaySchedulerTimeline(params: {
  state: CronServiceState;
  setNowMs: (ms: number) => void;
  steps: SchedulerReplayStep[];
}): Promise<SchedulerReplayTickSnapshot[]> {
  const snapshots: SchedulerReplayTickSnapshot[] = [];
  for (const step of params.steps) {
    const atMs = resolveReplayAtMs(step.at);
    const label = step.label ?? new Date(atMs).toISOString();
    const ticks = Math.max(1, Math.floor(step.ticks ?? 1));
    params.setNowMs(atMs);

    for (let tick = 1; tick <= ticks; tick += 1) {
      await onTimer(params.state);
      // Keep replay deterministic and prevent async timer callbacks
      // from adding extra implicit ticks outside the explicit sequence.
      stopTimer(params.state);
      await ensureLoaded(params.state, { forceReload: true, skipRecompute: true });
      snapshots.push({
        label,
        atMs,
        tick,
        jobs: (params.state.store?.jobs ?? []).map(snapshotJob),
      });
    }
  }
  return snapshots;
}
