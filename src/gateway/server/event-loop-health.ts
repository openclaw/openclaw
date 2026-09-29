// Event-loop health monitor samples delay, utilization, and CPU pressure for gateway readiness snapshots.
import { cpus, type CpuInfo } from "node:os";
import { createHistogram, performance, type RecordableHistogram } from "node:perf_hooks";
import { isMainThread, Worker } from "node:worker_threads";
import { hasInternalDiagnosticEventInterest } from "../../infra/diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent,
} from "../../infra/diagnostic-events.js";
import { runWithDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import type { GatewayScheduler } from "../../infra/gateway-scheduler.js";
import { getTrackedWorkerCpuSources } from "../../infra/worker-cpu.js";

const EVENT_LOOP_MONITOR_RESOLUTION_MS = 20;
const EVENT_LOOP_DELAY_WARN_MS = 1_000;
const EVENT_LOOP_UTILIZATION_WARN = 0.95;
const CPU_CORE_RATIO_WARN = 0.9;
const PERSISTENT_DEGRADATION_WARN_AFTER_MS = 60_000;
// Load counters can spike during frequent short async wakeups; delay is the blocking signal.
const LOAD_DEGRADATION_DELAY_COEVIDENCE_MS = 25;
const SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS = 1_000;
// A native request can wait on a blocked worker. It must not delay the sampler.
const WORKER_CPU_SAMPLE_BUDGET_MS = 100;

type EventLoopUtilization = ReturnType<typeof performance.eventLoopUtilization>;

type GatewayEventLoopHealthReason = "event_loop_delay" | "event_loop_utilization" | "cpu";

export type GatewayEventLoopHealth = {
  degraded: boolean;
  degradedSinceMs: number | null;
  reasons: GatewayEventLoopHealthReason[];
  intervalMs: number;
  delayP99Ms: number;
  delayMaxMs: number;
  utilization: number;
  cpuCoreRatio: number;
  cpuBreakdown?: {
    mainThreadCoreRatio?: number;
    workerCoreRatio?: number;
    otherThreadsCoreRatio?: number;
    hostUtilization?: number;
    hostCpuCount?: number;
  };
};

type GatewayEventLoopHealthMonitor = {
  snapshot: () => GatewayEventLoopHealth | undefined;
  persistentDegradationSnapshot: () => GatewayEventLoopHealth | undefined;
  reset: () => void;
  stop: () => void;
};

type EventLoopUtilizationReader = typeof performance.eventLoopUtilization;

type GatewayEventLoopHealthMonitorDeps = {
  scheduler: GatewayScheduler;
  now?: () => number;
  cpuUsage?: typeof process.cpuUsage;
  eventLoopUtilization?: EventLoopUtilizationReader;
};

type GatewayEventLoopHealthMetrics = Pick<
  GatewayEventLoopHealth,
  "intervalMs" | "delayP99Ms" | "delayMaxMs" | "utilization" | "cpuCoreRatio"
>;

function roundMetric(value: number, digits = 3): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nanosecondsToMilliseconds(value: number): number {
  return roundMetric(value / 1_000_000, 1);
}

function readMainThreadCpuUsage(): NodeJS.CpuUsage | undefined {
  try {
    const usage =
      isMainThread && typeof process.threadCpuUsage === "function"
        ? process.threadCpuUsage()
        : undefined;
    return cpuUsageDelta(usage, { user: 0, system: 0 }) === undefined ? undefined : usage;
  } catch {
    return undefined;
  }
}

function cpuUsageDelta(
  current: NodeJS.CpuUsage | undefined,
  previous: NodeJS.CpuUsage | undefined,
): number | undefined {
  if (!current || !previous) {
    return undefined;
  }
  const user = current.user - previous.user;
  const system = current.system - previous.system;
  return Number.isFinite(user + system) && user >= 0 && system >= 0 ? user + system : undefined;
}

function readHostCpuTimes(): CpuInfo["times"][] | undefined {
  try {
    const times = cpus().map((cpu) => cpu.times);
    return times.length &&
      times.every((cpu) =>
        [cpu.user, cpu.nice, cpu.sys, cpu.idle, cpu.irq].every(
          (value) => Number.isFinite(value) && value >= 0,
        ),
      )
      ? times
      : undefined;
  } catch {
    return undefined;
  }
}

function hostCpuUtilization(
  current: CpuInfo["times"][] | undefined,
  previous: CpuInfo["times"][] | undefined,
): number | undefined {
  if (!current || !previous || current.length !== previous.length) {
    return undefined;
  }
  let total = 0;
  let idle = 0;
  for (const [index, cpu] of current.entries()) {
    const before = previous[index]!;
    for (const key of ["user", "nice", "sys", "idle", "irq"] as const) {
      const delta = cpu[key] - before[key];
      if (delta < 0) {
        return undefined;
      }
      total += delta;
      if (key === "idle") {
        idle += delta;
      }
    }
  }
  return total > 0 && Number.isFinite(total) ? roundMetric((total - idle) / total) : undefined;
}

function classifyGatewayEventLoopHealthReasons(
  metrics: GatewayEventLoopHealthMetrics,
): GatewayEventLoopHealthReason[] {
  const reasons: GatewayEventLoopHealthReason[] = [];

  if (
    metrics.delayP99Ms >= EVENT_LOOP_DELAY_WARN_MS ||
    metrics.delayMaxMs >= EVENT_LOOP_DELAY_WARN_MS
  ) {
    reasons.push("event_loop_delay");
  }

  if (metrics.intervalMs < SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS) {
    return reasons;
  }

  const hasDelayCoEvidence =
    metrics.delayP99Ms >= LOAD_DEGRADATION_DELAY_COEVIDENCE_MS ||
    metrics.delayMaxMs >= LOAD_DEGRADATION_DELAY_COEVIDENCE_MS;
  if (!hasDelayCoEvidence) {
    return reasons;
  }

  if (metrics.utilization >= EVENT_LOOP_UTILIZATION_WARN) {
    reasons.push("event_loop_utilization");
  }
  if (metrics.cpuCoreRatio >= CPU_CORE_RATIO_WARN) {
    reasons.push("cpu");
  }

  return reasons;
}

export function createGatewayEventLoopHealthMonitor(
  deps: GatewayEventLoopHealthMonitorDeps,
): GatewayEventLoopHealthMonitor {
  const { scheduler } = deps;
  const nowMs = deps.now ?? performance.now.bind(performance);
  const readCpuUsage = deps.cpuUsage ?? process.cpuUsage.bind(process);
  const readEventLoopUtilization =
    deps.eventLoopUtilization ?? performance.eventLoopUtilization.bind(performance);
  let histogram: RecordableHistogram | null = null;
  let lastSampleAt = nowMs();
  let lastWallAt = lastSampleAt;
  let lastCpuUsage = readCpuUsage();
  let lastMainThreadCpuUsage = readMainThreadCpuUsage();
  let lastHostCpuTimes = readHostCpuTimes();
  let lastEventLoopUtilization: EventLoopUtilization = readEventLoopUtilization();
  let lastSnapshot: GatewayEventLoopHealth | undefined;
  let firstDegradedAtMs: number | null = null;
  type WorkerCpuWindow = {
    at: number;
    revision: number;
    usage: NodeJS.CpuUsage[];
  };
  let lastWorkerCpuWindow: WorkerCpuWindow | undefined;
  let cancelWorkerCpuSample: (() => void) | undefined;

  const captureWorkerCpu = (at: number, health?: GatewayEventLoopHealth) => {
    cancelWorkerCpuSample?.();
    const previous = lastWorkerCpuWindow;
    lastWorkerCpuWindow = undefined;
    // Bun 1.4.2 silently turns native worker-counter failures into zero. Main
    // thread and host counters remain usable; do not label that worker value idle.
    if (process.versions.bun || typeof Worker.prototype.cpuUsage !== "function") {
      return;
    }
    const { workers, revision } = getTrackedWorkerCpuSources();
    const accept = (usage: NodeJS.CpuUsage[]) => {
      if (revision !== getTrackedWorkerCpuSources().revision) {
        return;
      }
      lastWorkerCpuWindow = { at, revision, usage };
      if (
        !health ||
        lastSnapshot !== health ||
        !previous ||
        previous.revision !== revision ||
        at - previous.at !== health.intervalMs
      ) {
        return;
      }
      let total = 0;
      for (const [index, current] of usage.entries()) {
        const delta = cpuUsageDelta(current, previous.usage[index]);
        if (delta === undefined) {
          return;
        }
        total += delta;
      }
      const workerCoreRatio = roundMetric(total / (health.intervalMs * 1_000));
      const mainThreadCoreRatio = health.cpuBreakdown?.mainThreadCoreRatio;
      lastSnapshot = {
        ...health,
        cpuBreakdown: {
          ...health.cpuBreakdown,
          workerCoreRatio,
          ...(mainThreadCoreRatio === undefined
            ? {}
            : {
                // Cross-thread reads are not atomic; this is an estimated residual.
                otherThreadsCoreRatio: roundMetric(
                  Math.max(0, health.cpuCoreRatio - mainThreadCoreRatio - workerCoreRatio),
                ),
              }),
        },
      };
    };
    if (!workers.length) {
      accept([]);
      return;
    }
    let active = true;
    cancelWorkerCpuSample = () => {
      active = false;
    };
    const readings = workers.map(async (worker) => {
      try {
        return await worker.cpuUsage();
      } catch {
        return undefined;
      }
    });
    void Promise.all(readings).then((usage) => {
      if (!active || nowMs() - at > WORKER_CPU_SAMPLE_BUDGET_MS) {
        return;
      }
      const valid = usage.filter(
        (value): value is NodeJS.CpuUsage =>
          value !== undefined && cpuUsageDelta(value, { user: 0, system: 0 }) !== undefined,
      );
      if (valid.length === workers.length) {
        accept(valid);
      }
    });
  };

  try {
    // The default range covers 104 days; the int64 maximum fails on Linux Bun.
    histogram = createHistogram({ lowest: 1_000, figures: 3 });
  } catch {
    histogram = null;
  }

  const sample = () => {
    if (!histogram) {
      return;
    }

    const now = nowMs();
    // A window reset must not erase the pending sample's monotonic anchor.
    // Native interval histograms reset that anchor before an overdue callback runs.
    histogram.record(BigInt(Math.max(1, Math.round((now - lastSampleAt) * 1_000_000))));
    lastSampleAt = now;
    const intervalMs = Math.max(1, now - lastWallAt);
    const delayMaxMs = nanosecondsToMilliseconds(histogram.max);
    if (
      delayMaxMs < EVENT_LOOP_DELAY_WARN_MS &&
      intervalMs < SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS
    ) {
      return;
    }
    const delayP99Ms = nanosecondsToMilliseconds(histogram.percentile(99));

    const cpuUsage = readCpuUsage(lastCpuUsage);
    const currentEventLoopUtilization = readEventLoopUtilization();
    const utilization = roundMetric(
      readEventLoopUtilization(currentEventLoopUtilization, lastEventLoopUtilization).utilization,
    );
    const cpuTotalMs = roundMetric((cpuUsage.user + cpuUsage.system) / 1_000, 1);
    const cpuCoreRatio = roundMetric(cpuTotalMs / intervalMs);
    const mainThreadCpuUsage = readMainThreadCpuUsage();
    const mainThreadDelta = cpuUsageDelta(mainThreadCpuUsage, lastMainThreadCpuUsage);
    lastMainThreadCpuUsage = mainThreadCpuUsage;
    const hostCpuTimes = readHostCpuTimes();
    const hostUtilization = hostCpuUtilization(hostCpuTimes, lastHostCpuTimes);
    lastHostCpuTimes = hostCpuTimes;
    const reasons = classifyGatewayEventLoopHealthReasons({
      intervalMs,
      delayP99Ms,
      delayMaxMs,
      utilization,
      cpuCoreRatio,
    });
    const degraded = reasons.length > 0;
    if (degraded) {
      firstDegradedAtMs ??= now;
    } else {
      firstDegradedAtMs = null;
    }

    const health: GatewayEventLoopHealth = {
      degraded,
      degradedSinceMs:
        firstDegradedAtMs === null ? null : Math.max(0, Math.round(now - firstDegradedAtMs)),
      reasons,
      intervalMs,
      delayP99Ms,
      delayMaxMs,
      utilization,
      cpuCoreRatio,
      cpuBreakdown: {
        ...(mainThreadDelta === undefined
          ? {}
          : { mainThreadCoreRatio: roundMetric(mainThreadDelta / (intervalMs * 1_000)) }),
        ...(hostUtilization === undefined ? {} : { hostUtilization }),
        ...(hostCpuTimes ? { hostCpuCount: hostCpuTimes.length } : {}),
      },
    };

    histogram.reset();
    lastWallAt = now;
    lastCpuUsage = readCpuUsage();
    lastEventLoopUtilization = currentEventLoopUtilization;
    lastSnapshot = health;
    captureWorkerCpu(now, health);

    // Publish once at the sampling owner; readers never reset or commit observations.
    if (
      areDiagnosticsEnabledForProcess() &&
      hasInternalDiagnosticEventInterest("gateway.event_loop.sample")
    ) {
      runWithDiagnosticTraceContext(undefined, () =>
        emitInternalDiagnosticEvent({ type: "gateway.event_loop.sample", intervalMs, delayMaxMs }),
      );
    }
  };

  const samplingJob = histogram
    ? scheduler.schedule({
        id: "event-loop-health",
        atMs: scheduler.now() + EVENT_LOOP_MONITOR_RESOLUTION_MS,
        everyMs: EVENT_LOOP_MONITOR_RESOLUTION_MS,
        run: sample,
      })
    : undefined;
  if (histogram) {
    captureWorkerCpu(lastWallAt);
  }

  const reset = () => {
    histogram?.reset();
    lastSampleAt = nowMs();
    lastWallAt = lastSampleAt;
    lastCpuUsage = readCpuUsage();
    lastMainThreadCpuUsage = readMainThreadCpuUsage();
    lastHostCpuTimes = readHostCpuTimes();
    lastEventLoopUtilization = readEventLoopUtilization();
    lastSnapshot = undefined;
    firstDegradedAtMs = null;
    cancelWorkerCpuSample?.();
    lastWorkerCpuWindow = undefined;
    if (histogram) {
      captureWorkerCpu(lastWallAt);
    }
  };

  return {
    snapshot: () => lastSnapshot,
    // The heartbeat consumes the sampler's snapshot without advancing its window.
    persistentDegradationSnapshot: () => {
      const current = lastSnapshot;
      return current?.degradedSinceMs != null &&
        current.degradedSinceMs >= PERSISTENT_DEGRADATION_WARN_AFTER_MS
        ? current
        : undefined;
    },
    reset,
    stop: () => {
      samplingJob?.cancel();
      histogram = null;
      cancelWorkerCpuSample?.();
      lastWorkerCpuWindow = undefined;
      lastSnapshot = undefined;
      firstDegradedAtMs = null;
    },
  };
}
