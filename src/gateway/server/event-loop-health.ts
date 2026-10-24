import { cpus, type CpuInfo } from "node:os";
import { monitorEventLoopDelay, performance, type ELDHistogram } from "node:perf_hooks";
import { isMainThread, Worker } from "node:worker_threads";
import type { Static } from "typebox";
import type { SchemaContract } from "../../../packages/gateway-protocol/src/schema-contract.js";
import type { GatewayEventLoopHealthSchema } from "../../../packages/gateway-protocol/src/schema/runtime-vitals.js";
import {
  hasInternalDiagnosticEventInterest,
  onInternalDiagnosticEventInterest,
} from "../../infra/diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent,
} from "../../infra/diagnostic-events.js";
import { runWithDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import type { GatewayScheduler } from "../../infra/gateway-scheduler.js";
import { createMainThreadStallMonitor } from "../../infra/main-thread-stall.js";
import { getTrackedWorkerCpuSources } from "../../infra/worker-cpu.js";
import { roundDiagnosticMetric as roundMetric } from "../../logging/diagnostic-metric.js";
import { createStallFlightRecorder } from "../../logging/diagnostic-stall-flight-recorder.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const EVENT_LOOP_MONITOR_RESOLUTION_MS = 20;
const EVENT_LOOP_DELAY_WARN_MS = 1_000;
const EVENT_LOOP_UTILIZATION_WARN = 0.95;
const CPU_CORE_RATIO_WARN = 0.9;
const PERSISTENT_DEGRADATION_WARN_AFTER_MS = 60_000;
// Load counters can spike during frequent short async wakeups; delay is the blocking signal.
const LOAD_DEGRADATION_DELAY_COEVIDENCE_MS = 25;
const SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS = 1_000;
const IDLE_SAMPLE_INTERVAL_MS = 10_000;
// A native request can wait on a blocked worker. It must not delay the sampler.
const WORKER_CPU_SAMPLE_BUDGET_MS = 100;
const CPU_USAGE_ORIGIN = { user: 0, system: 0 };
const HOST_CPU_TIME_KEYS = ["user", "nice", "sys", "idle", "irq"] as const;
const log = createSubsystemLogger("gateway/event-loop");

type EventLoopUtilization = ReturnType<typeof performance.eventLoopUtilization>;

export type GatewayEventLoopHealth = SchemaContract<Static<typeof GatewayEventLoopHealthSchema>> & {
  degradedSinceMs: number | null;
};

type GatewayEventLoopHealthReason = GatewayEventLoopHealth["reasons"][number];

function nanosecondsToMilliseconds(value: number): number {
  return roundMetric(value / 1_000_000, 1);
}

function readMainThreadCpuUsage(): NodeJS.CpuUsage | undefined {
  try {
    const usage =
      isMainThread && typeof process.threadCpuUsage === "function"
        ? process.threadCpuUsage()
        : undefined;
    return isValidCpuUsage(usage) ? usage : undefined;
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

function isValidCpuUsage(usage: NodeJS.CpuUsage | undefined): usage is NodeJS.CpuUsage {
  return cpuUsageDelta(usage, CPU_USAGE_ORIGIN) !== undefined;
}

function readHostCpuTimes(): CpuInfo["times"][] | undefined {
  try {
    const times = cpus().map((cpu) => cpu.times);
    return times.length ? times : undefined;
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
  for (let index = 0; index < current.length; index++) {
    const cpu = current[index]!;
    const before = previous[index]!;
    for (const key of HOST_CPU_TIME_KEYS) {
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
  metrics: Pick<
    GatewayEventLoopHealth,
    "intervalMs" | "delayP99Ms" | "delayMaxMs" | "utilization" | "cpuCoreRatio"
  >,
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

export function createGatewayEventLoopHealthMonitor(deps: {
  scheduler: GatewayScheduler;
  isIdle?: () => boolean;
}): {
  snapshot: () => GatewayEventLoopHealth | undefined;
  persistentDegradationSnapshot: () => GatewayEventLoopHealth | undefined;
  reset: () => void;
  stop: () => void;
} {
  const { scheduler } = deps;
  const nowMs = performance.now.bind(performance);
  const readCpuUsage = process.cpuUsage.bind(process);
  const readEventLoopUtilization = performance.eventLoopUtilization.bind(performance);
  const flightRecorder = createStallFlightRecorder((message) => log.warn(message));
  const stalls = createMainThreadStallMonitor(nowMs);
  let unattributedDelayMs = 0;
  let histogram: ELDHistogram | null = null;
  let histogramEnabled = true;
  let sampleDueAt = 0;
  let lastWallAt = nowMs();
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
    const { workers, revision, currentRevision } = getTrackedWorkerCpuSources();
    const accept = (usage: NodeJS.CpuUsage[]) => {
      if (revision !== currentRevision()) {
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
      for (let index = 0; index < usage.length; index++) {
        const delta = cpuUsageDelta(usage[index], previous.usage[index]);
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
    const readings = workers.map((worker) => worker.cpuUsage());
    void Promise.all(readings).then((usage) => {
      if (!active || nowMs() - at > WORKER_CPU_SAMPLE_BUDGET_MS) {
        return;
      }
      if (usage.every(isValidCpuUsage)) {
        accept(usage);
      }
    });
  };

  try {
    histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_MONITOR_RESOLUTION_MS });
    histogram.enable();
  } catch {
    histogram = null;
  }

  const sample = () => {
    if (!histogram) {
      return;
    }

    const now = nowMs();
    const attributed = stalls.drain();
    if (
      attributed.stalls.length > 0 &&
      areDiagnosticsEnabledForProcess() &&
      hasInternalDiagnosticEventInterest("gateway.main_thread.stall")
    ) {
      runWithDiagnosticTraceContext(undefined, () =>
        emitInternalDiagnosticEvent({
          type: "gateway.main_thread.stall",
          stalls: attributed.stalls.map((stall) => ({
            task: stall.task,
            durationMs: stall.elapsedMs,
          })),
          dropped: attributed.dropped,
        }),
      );
    }
    // Idle windows retain callback attribution and overdue-deadline detection without
    // the native histogram's 20 ms wakeup. Full resolution returns with active work.
    const delayMaxMs = Math.max(
      histogramEnabled ? nanosecondsToMilliseconds(histogram.max) : Math.max(0, now - sampleDueAt),
      attributed.delayMaxMs,
    );
    let longestStallMs = attributed.stalls.length === 0 ? unattributedDelayMs : 0;
    for (const stall of attributed.stalls) {
      longestStallMs = Math.max(longestStallMs, stall.elapsedMs);
    }
    const profile = flightRecorder.sample(longestStallMs);
    if (unattributedDelayMs > 0 && attributed.stalls.length === 0) {
      log.warn(`main-thread stall: elapsedMs=${Math.round(unattributedDelayMs)} task=unattributed`);
    }
    unattributedDelayMs =
      delayMaxMs > EVENT_LOOP_DELAY_WARN_MS && attributed.stalls.length === 0 ? delayMaxMs : 0;
    for (const stall of attributed.stalls) {
      log.warn(
        `main-thread stall: elapsedMs=${Math.round(stall.elapsedMs)} task=${JSON.stringify(stall.task.slice(0, 160))} taskMs=${Math.round(stall.taskMs)}`,
      );
    }
    // Several callbacks can finish before this sample; the trailing profile is batch evidence.
    if (profile) {
      log.warn(`main-thread stall profile: ${profile}`);
    }
    const intervalMs = Math.max(1, now - lastWallAt);
    if (attributed.dropped > 0) {
      log.warn(`main-thread stall: omitted=${attributed.dropped} pendingLimit=8`);
    }
    if (
      delayMaxMs < EVENT_LOOP_DELAY_WARN_MS &&
      intervalMs < SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS
    ) {
      // Reset can leave an earlier wake pending; finish the new window on time.
      samplingJob = scheduleSample(SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS - intervalMs);
      return;
    }
    const delayP99Ms = histogramEnabled ? nanosecondsToMilliseconds(histogram.percentile(99)) : 0;

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
    samplingJob = scheduleSample(
      !degraded &&
        deps.isIdle?.() &&
        !hasInternalDiagnosticEventInterest("gateway.event_loop.sample")
        ? IDLE_SAMPLE_INTERVAL_MS
        : SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS,
    );
  };

  const scheduleSample = (delayMs: number) => {
    const enableHistogram = delayMs !== IDLE_SAMPLE_INTERVAL_MS;
    if (histogram && histogramEnabled !== enableHistogram) {
      histogramEnabled = enableHistogram;
      if (enableHistogram) {
        histogram.reset();
        histogram.enable();
      } else {
        histogram.disable();
      }
    }
    const job = scheduler.schedule({
      id: "event-loop-health",
      delayMs,
      phase: delayMs === IDLE_SAMPLE_INTERVAL_MS ? "maintenance" : undefined,
      // Let the blocking task scope publish its stall before resetting the window.
      run: () => queueMicrotask(sample),
    });
    sampleDueAt = nowMs() + (job.atMs - scheduler.now());
    return job;
  };
  let samplingJob = histogram ? scheduleSample(SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS) : undefined;
  if (histogram) {
    captureWorkerCpu(lastWallAt);
  }
  const unsubscribeInterest = onInternalDiagnosticEventInterest("gateway.event_loop.sample", () => {
    const now = nowMs();
    const nextSampleAt = Math.max(now, lastWallAt + SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS);
    if (histogram && nextSampleAt < sampleDueAt) {
      samplingJob = scheduleSample(nextSampleAt - now);
    }
  });

  const reset = () => {
    stalls.reset();
    unattributedDelayMs = 0;
    histogram?.reset();
    lastWallAt = nowMs();
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
      samplingJob = scheduleSample(SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS);
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
      unsubscribeInterest();
      flightRecorder.stop();
      stalls.stop();
      samplingJob?.cancel();
      histogram?.disable();
      histogram = null;
      cancelWorkerCpuSample?.();
      lastWorkerCpuWindow = undefined;
      lastSnapshot = undefined;
      firstDegradedAtMs = null;
    },
  };
}
