import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import { totalmem } from "node:os";
import { getHeapSpaceStatistics, getHeapStatistics } from "node:v8";
import {
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
  type DiagnosticMemoryPressureEvent,
  type DiagnosticMemoryUsage,
} from "../infra/diagnostic-events.js";
import { getOldGenerationAfterGcBytes } from "../infra/gc-observer.js";
import { sampleTrackedWorkerMemory } from "../infra/worker-cpu.js";
import { getWorkerMessageMetrics } from "../infra/worker-message-metrics.js";
import { createSubsystemLogger } from "./subsystem.js";

const WARNING_RATIO = 0.8;
const CRITICAL_RATIO = 0.9;
const DEFAULT_PRESSURE_REPEAT_MS = 5 * 60 * 1000;
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
// Retain the named channel between samples, including periods without subscribers.
const memoryPressure = channel("openclaw.memory.critical");

// Bun's compatibility probe walks the heap and does not describe a V8 allocation limit.
let defaultHeapSizeLimitBytes: number | undefined;
const DEFAULT_PROCESS_MEMORY_LIMIT_BYTES = process.constrainedMemory();
const DEFAULT_PHYSICAL_MEMORY_BYTES = totalmem();
const DEFAULT_IS_BUN_RUNTIME = typeof process.versions.bun === "string";

const log = createSubsystemLogger("gateway").child("diagnostics/memory");

type DiagnosticMemoryThresholds = {
  rssWarningBytes?: number;
  rssCriticalBytes?: number;
  heapUsedWarningBytes?: number;
  heapUsedCriticalBytes?: number;
  pressureRepeatMs?: number;
};

type MemoryPressure = Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type"> & {
  usedBytes: number;
  thresholdBytes: number;
};
const lastPressureAtByKey = new Map<string, number>();

type ProcessFootprint = Pick<DiagnosticMemoryUsage, "anonymousRssBytes" | "anonymousSwapBytes">;

async function readProcessFootprint(): Promise<ProcessFootprint> {
  const processFootprint: ProcessFootprint = {};
  try {
    const status = await fs.readFile("/proc/self/status", "utf8");
    for (const [counter, field] of [
      ["RssAnon", "anonymousRssBytes"],
      ["VmSwap", "anonymousSwapBytes"],
    ] as const) {
      const value = status.match(new RegExp(`^${counter}:\\s+(\\d+)\\s+kB$`, "m"))?.[1];
      if (value !== undefined) {
        processFootprint[field] = Number(value) * 1024;
      }
    }
  } catch {
    // Restricted proc mounts may provide no anonymous-page counters.
  }
  return processFootprint;
}

/** One pending OS read must never hold the heartbeat's liveness or pressure checks. */
export function createDiagnosticMemorySampler(isCurrent: () => boolean) {
  let pending = false;
  return (
    emitSample: boolean,
    options?: { emitMemorySample?: EmitDiagnosticMemorySample },
  ): void => {
    if (options?.emitMemorySample) {
      options.emitMemorySample({ emitSample });
      return;
    }
    const linuxSample = emitSample && process.platform === "linux";
    const sampledAt = performance.now();
    const memory = emitDiagnosticMemorySample({ emitSample: emitSample && !linuxSample });
    if (!linuxSample || pending) {
      return;
    }
    pending = true;
    const uptimeMs = Math.round(process.uptime() * 1000);
    void readProcessFootprint().then((processFootprint) => {
      pending = false;
      if (isCurrent()) {
        const publicationDelayMs = Math.round(performance.now() - sampledAt);
        // The event timestamp is publication time; age the acquired samples without
        // mutating rows already shared with pressure events. Coverage stays acquisition-scoped.
        publishMemorySample(
          {
            ...memory,
            ...processFootprint,
            workerHeaps: memory.workerHeaps?.map((worker) =>
              worker.sampleAgeMs === undefined
                ? worker
                : Object.assign({}, worker, {
                    sampleAgeMs: worker.sampleAgeMs + publicationDelayMs,
                  }),
            ),
          },
          uptimeMs,
        );
      }
    });
  };
}

function publishMemorySample(memory: DiagnosticMemoryUsage, uptimeMs: number): void {
  emitDiagnosticEvent({
    type: "diagnostic.memory.sample",
    memory: {
      ...memory,
      heapSpaces: DEFAULT_IS_BUN_RUNTIME ? undefined : getHeapSpaceStatistics(),
    },
    uptimeMs,
  });
}

function isPositiveMemoryLimit(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeMemoryUsage(
  memory: NodeJS.MemoryUsage,
  collectDiagnostics: boolean,
): DiagnosticMemoryUsage {
  return {
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    ...(collectDiagnostics
      ? { ...sampleTrackedWorkerMemory(), workerMessages: getWorkerMessageMetrics() }
      : {}),
  };
}

function pickPressure(
  memory: DiagnosticMemoryUsage,
  heapLimitBytes: number | undefined,
  rssLimitBytes: number | undefined,
  thresholds?: DiagnosticMemoryThresholds,
): MemoryPressure | null {
  // Compare isolates to their own limits, never summed worker heaps to the main heap.
  // Within each severity the main heap is primary, followed by workers and process RSS.
  const signals: {
    reason: MemoryPressure["reason"];
    usedBytes: number;
    limitBytes?: number;
    warning?: number;
    critical?: number;
    workerThreadId?: number;
  }[] = [
    {
      reason: "heap_threshold" as const,
      usedBytes: memory.heapUsedBytes,
      limitBytes: heapLimitBytes,
      warning: thresholds?.heapUsedWarningBytes,
      critical: thresholds?.heapUsedCriticalBytes,
    },
    ...(memory.workerHeaps ?? []).map((worker) => ({
      reason: "worker_heap_threshold" as const,
      usedBytes: worker.heapUsed,
      limitBytes: worker.heapSizeLimitBytes,
      workerThreadId: worker.threadId,
      warning: undefined,
      critical: undefined,
    })),
    {
      reason: "rss_threshold" as const,
      usedBytes: memory.rssBytes,
      limitBytes: rssLimitBytes,
      warning: thresholds?.rssWarningBytes,
      critical: thresholds?.rssCriticalBytes,
    },
  ];
  for (const [level, ratio] of [
    ["critical", CRITICAL_RATIO],
    ["warning", WARNING_RATIO],
  ] as const) {
    for (const { reason, usedBytes, limitBytes, workerThreadId, ...signal } of signals) {
      const thresholdBytes =
        signal[level] ??
        (isPositiveMemoryLimit(limitBytes) ? Math.floor(limitBytes * ratio) : undefined);
      if (isPositiveMemoryLimit(thresholdBytes) && usedBytes >= thresholdBytes) {
        return {
          level,
          reason,
          memory,
          usedBytes,
          limitBytes,
          thresholdBytes,
          workerThreadId,
        };
      }
    }
  }
  return null;
}

function shouldEmitPressure(pressure: MemoryPressure, now: number, repeatMs: number): boolean {
  const key = `${pressure.level}:${pressure.reason}`;
  const lastAt = lastPressureAtByKey.get(key);
  // Pressure events can repeat during sustained memory spikes; throttle per level/reason pair.
  if (lastAt !== undefined && now - lastAt < repeatMs) {
    return false;
  }
  lastPressureAtByKey.set(key, now);
  return true;
}

function formatOptionalPressureMetric(label: string, value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? ` ${label}=${value}` : "";
}

function formatScaledNumber(value: number): string {
  const fixed = value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return fixed.replace(/\.0+$/u, "").replace(/(\.\d*[1-9])0$/u, "$1");
}

function formatReadableBytes(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  let scaled = value;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unitIndex++;
  }
  return unitIndex === 0
    ? `${Math.round(scaled)} ${BYTE_UNITS[unitIndex]}`
    : `${formatScaledNumber(scaled)} ${BYTE_UNITS[unitIndex]}`;
}

function formatPressureSummary(pressure: MemoryPressure): string {
  const ratio = Number.isFinite(pressure.usedBytes)
    ? `${formatScaledNumber((pressure.usedBytes / pressure.thresholdBytes) * 100)}%`
    : undefined;
  const parts = [
    `rss=${formatReadableBytes(pressure.memory.rssBytes)}`,
    `heap=${formatReadableBytes(pressure.memory.heapUsedBytes)}`,
    `threshold=${formatReadableBytes(pressure.thresholdBytes)}`,
    `thresholdRatio=${ratio}`,
    pressure.limitBytes !== undefined ? `limit=${formatReadableBytes(pressure.limitBytes)}` : "",
    `used=${formatReadableBytes(pressure.usedBytes)}`,
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}

function logMemoryPressure(pressure: MemoryPressure): void {
  const nextStep =
    pressure.level === "critical"
      ? "nextStep=run openclaw gateway diagnostics export, inspect an existing bundle with openclaw gateway stability --bundle latest, or sample allocations with openclaw gateway call diagnostics.heapProfile --timeout 30000."
      : "nextStep=run openclaw gateway status --deep and openclaw gateway diagnostics export; restart gateway if pressure persists";
  const message =
    `memory pressure: level=${pressure.level} reason=${pressure.reason}` +
    ` ${formatPressureSummary(pressure)}` +
    ` rssBytes=${pressure.memory.rssBytes}` +
    ` heapUsedBytes=${pressure.memory.heapUsedBytes}` +
    ` externalBytes=${pressure.memory.externalBytes}` +
    ` arrayBuffersBytes=${pressure.memory.arrayBuffersBytes}` +
    formatOptionalPressureMetric("workerHeapTotalBytes", pressure.memory.workerHeapTotalBytes) +
    formatOptionalPressureMetric("workerHeapUsedBytes", pressure.memory.workerHeapUsedBytes) +
    formatOptionalPressureMetric("workerExternalBytes", pressure.memory.workerExternalBytes) +
    formatOptionalPressureMetric(
      "workerArrayBuffersBytes",
      pressure.memory.workerArrayBuffersBytes,
    ) +
    formatOptionalPressureMetric("workerCount", pressure.memory.workerCount) +
    formatOptionalPressureMetric("workerHeapSampledCount", pressure.memory.workerHeapSampledCount) +
    formatOptionalPressureMetric(
      "workerArrayBuffersSampledCount",
      pressure.memory.workerArrayBuffersSampledCount,
    ) +
    (pressure.memory.workerMemoryCoverage
      ? ` workerMemoryCoverage=${pressure.memory.workerMemoryCoverage} workerMemoryScope=direct`
      : "") +
    (pressure.memory.workerMemoryMissing?.length
      ? ` workerMemoryMissing=${JSON.stringify(pressure.memory.workerMemoryMissing.slice(0, 5))}`
      : "") +
    (pressure.memory.workerHeaps?.length
      ? ` workerHeaps=${JSON.stringify(
          pressure.memory.workerHeaps
            .toSorted((a, b) => b.heapUsed + (b.external ?? 0) - a.heapUsed - (a.external ?? 0))
            .slice(0, 5),
        )}`
      : "") +
    formatOptionalPressureMetric("thresholdBytes", pressure.thresholdBytes) +
    formatOptionalPressureMetric("limitBytes", pressure.limitBytes) +
    formatOptionalPressureMetric("usedBytes", pressure.usedBytes) +
    formatOptionalPressureMetric("workerThreadId", pressure.workerThreadId) +
    (pressure.memory.workerCount
      ? " workerLimitScope=js-heap-only; external/ArrayBuffers are not capped; nested workers are not included."
      : "") +
    ` ${nextStep}`;
  log.warn(message);
}

export function emitDiagnosticMemorySample(
  options?: {
    now?: number;
    memoryUsage?: NodeJS.MemoryUsage;
    heapSizeLimitBytes?: number;
    processMemoryLimitBytes?: number;
    physicalMemoryBytes?: number;
    isBunRuntime?: boolean;
    uptimeMs?: number;
    thresholds?: DiagnosticMemoryThresholds;
    emitSample?: boolean;
  },
  collectDiagnostics = true,
): DiagnosticMemoryUsage {
  const now = options?.now ?? Date.now();
  const memory = normalizeMemoryUsage(
    options?.memoryUsage ?? process.memoryUsage(),
    collectDiagnostics,
  );
  const isBun = options?.isBunRuntime ?? DEFAULT_IS_BUN_RUNTIME;
  const heapLimitBytes = isBun
    ? undefined
    : (options?.heapSizeLimitBytes ??
      (defaultHeapSizeLimitBytes ??= getHeapStatistics().heap_size_limit));
  const memoryLimits = [
    options?.processMemoryLimitBytes ?? DEFAULT_PROCESS_MEMORY_LIMIT_BYTES,
    options?.physicalMemoryBytes ?? DEFAULT_PHYSICAL_MEMORY_BYTES,
  ].filter(isPositiveMemoryLimit);
  const rssLimitBytes = memoryLimits.length ? Math.min(...memoryLimits) : undefined;
  const shouldEmitSample = collectDiagnostics && options?.emitSample !== false;
  memory.heapSizeLimitBytes = heapLimitBytes;
  memory.oldGenerationAfterGcBytes = isBun ? undefined : getOldGenerationAfterGcBytes();

  if (shouldEmitSample) {
    publishMemorySample(memory, options?.uptimeMs ?? Math.round(process.uptime() * 1000));
  }

  const pressure = pickPressure(memory, heapLimitBytes, rssLimitBytes, options?.thresholds);
  if (pressure?.level === "critical") {
    memoryPressure.publish(undefined);
  }
  if (
    collectDiagnostics &&
    pressure &&
    shouldEmitPressure(
      pressure,
      now,
      options?.thresholds?.pressureRepeatMs ?? DEFAULT_PRESSURE_REPEAT_MS,
    )
  ) {
    emitDiagnosticEvent({
      type: "diagnostic.memory.pressure",
      ...pressure,
    });
    logMemoryPressure(pressure);
  }
  return memory;
}

/** @internal Test-support reset; see diagnostic.test-support.ts. */
export function resetDiagnosticMemoryForTest(): void {
  lastPressureAtByKey.clear();
}

// The logging-core SDK shipped these optional inputs before automatic bundles retired.
export type EmitDiagnosticMemorySample = (
  options?: NonNullable<Parameters<typeof emitDiagnosticMemorySample>[0]> & {
    // Previously exposed callback input; RSS growth no longer determines pressure.
    thresholds?: DiagnosticMemoryThresholds & {
      rssGrowthWarningBytes?: number;
      rssGrowthCriticalBytes?: number;
      growthWindowMs?: number;
    };
    writeCriticalBundle?: boolean;
    stateDir?: string;
    sessionStorePaths?: string[];
    resolveSessionStorePaths?: () => string[] | undefined;
  },
) => ReturnType<typeof emitDiagnosticMemorySample>;
