import { channel } from "node:diagnostics_channel";
import { totalmem } from "node:os";
// Diagnostic memory helpers capture process memory facts for support diagnostics.
import { getHeapStatistics } from "node:v8";
import {
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
  type DiagnosticMemoryPressureEvent,
  type DiagnosticMemoryUsage,
} from "../infra/diagnostic-events.js";
import { sampleTrackedWorkerMemory } from "../infra/worker-cpu.js";
import { createSubsystemLogger } from "./subsystem.js";

// Diagnostic memory sampler with threshold/growth pressure detection and repeat suppression.
const MB = 1024 * 1024;
const GB = 1024 * MB;
const DEFAULT_RSS_WARNING_BYTES = 1536 * MB;
const DEFAULT_RSS_CRITICAL_BYTES = 3072 * MB;
const DEFAULT_HEAP_WARNING_BYTES = 1024 * MB;
const DEFAULT_HEAP_CRITICAL_BYTES = 2048 * MB;
const DEFAULT_HEAP_WARNING_RATIO = 0.5;
const DEFAULT_HEAP_CRITICAL_RATIO = 0.75;
const BUN_HEAP_WARNING_MAX_BYTES = 4 * GB;
const BUN_HEAP_CRITICAL_MAX_BYTES = 6 * GB;
const DEFAULT_RSS_GROWTH_WARNING_BYTES = 512 * MB;
const DEFAULT_RSS_GROWTH_CRITICAL_BYTES = 1024 * MB;
const DEFAULT_RSS_GROWTH_WARNING_RATIO = 0.04;
const DEFAULT_RSS_GROWTH_CRITICAL_RATIO = 0.08;
const DEFAULT_GROWTH_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_PRESSURE_REPEAT_MS = 5 * 60 * 1000;
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

const DEFAULT_HEAP_SIZE_LIMIT_BYTES = getHeapStatistics().heap_size_limit;
const DEFAULT_PROCESS_MEMORY_LIMIT_BYTES = process.constrainedMemory();
const DEFAULT_PHYSICAL_MEMORY_BYTES = totalmem();
const DEFAULT_IS_BUN_RUNTIME = typeof process.versions.bun === "string";

const log = createSubsystemLogger("gateway").child("diagnostics/memory");

type DiagnosticMemoryThresholds = {
  rssWarningBytes?: number;
  rssCriticalBytes?: number;
  heapUsedWarningBytes?: number;
  heapUsedCriticalBytes?: number;
  rssGrowthWarningBytes?: number;
  rssGrowthCriticalBytes?: number;
  growthWindowMs?: number;
  pressureRepeatMs?: number;
};

type DiagnosticMemorySample = {
  ts: number;
  memory: DiagnosticMemoryUsage;
};

type DiagnosticMemoryState = {
  growth: {
    lastSampleAt: number;
    windowStart: number;
    windowMinimum: DiagnosticMemorySample;
    previousMinimum: DiagnosticMemorySample | null;
    baseline: DiagnosticMemorySample;
    risingWindows: number;
  } | null;
  lastPressureAtByKey: Map<string, number>;
};

function isPositiveMemoryLimit(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveProcessMemoryLimitBytes(
  processMemoryLimitBytes: number | undefined,
  physicalMemoryBytes: number | undefined,
  isBunRuntime: boolean,
): number | undefined {
  if (!isPositiveMemoryLimit(processMemoryLimitBytes)) {
    // Node can report no constraint even when an explicit heap exceeds physical RAM.
    // Keep Bun's existing no-constraint RSS policy independent of its compatibility heap.
    return !isBunRuntime && isPositiveMemoryLimit(physicalMemoryBytes)
      ? physicalMemoryBytes
      : undefined;
  }
  return isPositiveMemoryLimit(physicalMemoryBytes)
    ? Math.min(processMemoryLimitBytes, physicalMemoryBytes)
    : processMemoryLimitBytes;
}

const state: DiagnosticMemoryState = {
  growth: null,
  lastPressureAtByKey: new Map(),
};

// Convert Node's runtime shape into the diagnostic event contract.
function normalizeMemoryUsage(memory: NodeJS.MemoryUsage): DiagnosticMemoryUsage {
  return {
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    ...sampleTrackedWorkerMemory(),
  };
}

function resolveThresholds(
  thresholds?: DiagnosticMemoryThresholds,
  heapSizeLimitBytes?: number,
  processMemoryLimitBytes?: number,
  physicalMemoryBytes?: number,
  isBunRuntime = false,
): Required<DiagnosticMemoryThresholds> {
  const hasHeapLimit = isPositiveMemoryLimit(heapSizeLimitBytes);
  // Node pressure follows the measured V8 limit, including explicit larger heaps.
  // Bun's node:v8 compatibility metadata retains its existing caps.
  const heapWarningBytes = hasHeapLimit
    ? Math.min(
        Math.floor(heapSizeLimitBytes * DEFAULT_HEAP_WARNING_RATIO),
        isBunRuntime ? BUN_HEAP_WARNING_MAX_BYTES : Infinity,
      )
    : DEFAULT_HEAP_WARNING_BYTES;
  const heapCriticalBytes = hasHeapLimit
    ? Math.min(
        Math.floor(heapSizeLimitBytes * DEFAULT_HEAP_CRITICAL_RATIO),
        isBunRuntime ? BUN_HEAP_CRITICAL_MAX_BYTES : Infinity,
      )
    : DEFAULT_HEAP_CRITICAL_BYTES;
  const usableProcessMemoryLimitBytes = resolveProcessMemoryLimitBytes(
    processMemoryLimitBytes,
    physicalMemoryBytes,
    isBunRuntime,
  );
  const hasProcessMemoryLimit = usableProcessMemoryLimitBytes !== undefined;
  // Bun's node:v8 heap limit is compatibility metadata, not an RSS process budget.
  const useBunRssCaps = isBunRuntime && hasProcessMemoryLimit;
  const useHeapForRss = !isBunRuntime && hasHeapLimit;
  const rssWarningBase = useBunRssCaps
    ? BUN_HEAP_WARNING_MAX_BYTES
    : useHeapForRss
      ? Math.max(DEFAULT_RSS_WARNING_BYTES, heapWarningBytes)
      : DEFAULT_RSS_WARNING_BYTES;
  const rssCriticalBase = useBunRssCaps
    ? BUN_HEAP_CRITICAL_MAX_BYTES
    : useHeapForRss
      ? Math.max(DEFAULT_RSS_CRITICAL_BYTES, heapCriticalBytes)
      : DEFAULT_RSS_CRITICAL_BYTES;
  const processWarningBytes = hasProcessMemoryLimit
    ? Math.floor(usableProcessMemoryLimitBytes * DEFAULT_HEAP_WARNING_RATIO)
    : rssWarningBase;
  const processCriticalBytes = hasProcessMemoryLimit
    ? Math.floor(usableProcessMemoryLimitBytes * DEFAULT_HEAP_CRITICAL_RATIO)
    : rssCriticalBase;
  const growthMemoryLimitBytes = useHeapForRss
    ? Math.min(heapSizeLimitBytes, usableProcessMemoryLimitBytes ?? heapSizeLimitBytes)
    : 0;
  return {
    rssWarningBytes: thresholds?.rssWarningBytes ?? Math.min(rssWarningBase, processWarningBytes),
    rssCriticalBytes:
      thresholds?.rssCriticalBytes ?? Math.min(rssCriticalBase, processCriticalBytes),
    heapUsedWarningBytes: thresholds?.heapUsedWarningBytes ?? heapWarningBytes,
    heapUsedCriticalBytes: thresholds?.heapUsedCriticalBytes ?? heapCriticalBytes,
    rssGrowthWarningBytes:
      thresholds?.rssGrowthWarningBytes ??
      Math.max(
        DEFAULT_RSS_GROWTH_WARNING_BYTES,
        Math.floor(growthMemoryLimitBytes * DEFAULT_RSS_GROWTH_WARNING_RATIO),
      ),
    rssGrowthCriticalBytes:
      thresholds?.rssGrowthCriticalBytes ??
      Math.max(
        DEFAULT_RSS_GROWTH_CRITICAL_BYTES,
        Math.floor(growthMemoryLimitBytes * DEFAULT_RSS_GROWTH_CRITICAL_RATIO),
      ),
    growthWindowMs: thresholds?.growthWindowMs ?? DEFAULT_GROWTH_WINDOW_MS,
    pressureRepeatMs: thresholds?.pressureRepeatMs ?? DEFAULT_PRESSURE_REPEAT_MS,
  };
}

function pickThresholdPressure(params: {
  memory: DiagnosticMemoryUsage;
  thresholds: Required<DiagnosticMemoryThresholds>;
}): Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type"> | null {
  const { memory, thresholds } = params;
  // First match wins: critical pressure precedes warnings, with RSS first at each level.
  const candidates = [
    [memory.rssBytes, thresholds.rssCriticalBytes, "critical", "rss_threshold"],
    [memory.heapUsedBytes, thresholds.heapUsedCriticalBytes, "critical", "heap_threshold"],
    [memory.rssBytes, thresholds.rssWarningBytes, "warning", "rss_threshold"],
    [memory.heapUsedBytes, thresholds.heapUsedWarningBytes, "warning", "heap_threshold"],
  ] as const;
  for (const [value, thresholdBytes, level, reason] of candidates) {
    if (value >= thresholdBytes) {
      return { level, reason, memory, thresholdBytes };
    }
  }
  return null;
}

function pickGrowthPressure(params: {
  current: DiagnosticMemorySample;
  thresholds: Required<DiagnosticMemoryThresholds>;
}): Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type"> | null {
  const { current, thresholds } = params;
  const growth = state.growth;
  if (
    !growth ||
    current.ts <= growth.lastSampleAt ||
    current.ts - growth.lastSampleAt > thresholds.growthWindowMs
  ) {
    state.growth = {
      lastSampleAt: current.ts,
      windowStart: current.ts,
      windowMinimum: current,
      previousMinimum: null,
      baseline: current,
      risingWindows: 0,
    };
    return null;
  }
  growth.lastSampleAt = current.ts;
  if (current.memory.rssBytes < growth.windowMinimum.memory.rssBytes) {
    growth.windowMinimum = current;
  }
  // Compare completed half-window floors so a GC peak cannot count as retained growth.
  if (current.ts - growth.windowStart < thresholds.growthWindowMs / 2) {
    return null;
  }
  const minimum = growth.windowMinimum;
  const previous = growth.previousMinimum;
  growth.windowStart = current.ts;
  growth.windowMinimum = current;
  growth.previousMinimum = minimum;
  if (!previous || minimum.memory.rssBytes <= previous.memory.rssBytes) {
    growth.baseline = minimum;
    growth.risingWindows = 0;
    return null;
  }
  growth.risingWindows++;
  if (growth.risingWindows < 2) {
    return null;
  }
  const windowMs = minimum.ts - growth.baseline.ts;
  const rssGrowthBytes = minimum.memory.rssBytes - growth.baseline.memory.rssBytes;
  if (rssGrowthBytes >= thresholds.rssGrowthCriticalBytes) {
    return {
      level: "critical",
      reason: "rss_growth",
      memory: current.memory,
      thresholdBytes: thresholds.rssGrowthCriticalBytes,
      rssGrowthBytes,
      windowMs,
    };
  }
  if (rssGrowthBytes >= thresholds.rssGrowthWarningBytes) {
    return {
      level: "warning",
      reason: "rss_growth",
      memory: current.memory,
      thresholdBytes: thresholds.rssGrowthWarningBytes,
      rssGrowthBytes,
      windowMs,
    };
  }
  return null;
}

function shouldEmitPressure(
  pressure: Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type">,
  now: number,
  repeatMs: number,
): boolean {
  const key = `${pressure.level}:${pressure.reason}`;
  const lastAt = state.lastPressureAtByKey.get(key);
  // Pressure events can repeat during sustained memory spikes; throttle per level/reason pair.
  if (lastAt !== undefined && now - lastAt < repeatMs) {
    return false;
  }
  state.lastPressureAtByKey.set(key, now);
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

function formatPressureRatio(params: {
  pressure: Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type">;
  thresholdBytes: number;
}): string | undefined {
  const { pressure, thresholdBytes } = params;
  if (!Number.isFinite(thresholdBytes) || thresholdBytes <= 0) {
    return undefined;
  }
  const value =
    pressure.reason === "heap_threshold"
      ? pressure.memory.heapUsedBytes
      : pressure.reason === "rss_growth"
        ? pressure.rssGrowthBytes
        : pressure.memory.rssBytes;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const ratio = (value / thresholdBytes) * 100;
  return `${formatScaledNumber(ratio)}%`;
}

function formatPressureSummary(
  pressure: Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type">,
): string {
  const parts = [
    `rss=${formatReadableBytes(pressure.memory.rssBytes)}`,
    `heap=${formatReadableBytes(pressure.memory.heapUsedBytes)}`,
    pressure.thresholdBytes !== undefined
      ? `threshold=${formatReadableBytes(pressure.thresholdBytes)}`
      : "",
    pressure.thresholdBytes !== undefined
      ? `thresholdRatio=${formatPressureRatio({
          pressure,
          thresholdBytes: pressure.thresholdBytes,
        })}`
      : "",
    pressure.rssGrowthBytes !== undefined
      ? `rssGrowth=${formatReadableBytes(pressure.rssGrowthBytes)}`
      : "",
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}

function logMemoryPressure(
  pressure: Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type">,
): void {
  const nextStep =
    pressure.level === "critical"
      ? "nextStep=run openclaw gateway diagnostics export, inspect an existing bundle with openclaw gateway stability --bundle latest, or on Node sample allocations with openclaw gateway call diagnostics.heapProfile --timeout 30000."
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
    formatOptionalPressureMetric("rssGrowthBytes", pressure.rssGrowthBytes) +
    formatOptionalPressureMetric("windowMs", pressure.windowMs) +
    (pressure.memory.workerCount
      ? " workerLimitScope=js-heap-only; external/ArrayBuffers are not capped; nested workers are not included."
      : "") +
    ` ${nextStep}`;
  log.warn(message);
}

export function emitDiagnosticMemorySample(options?: {
  now?: number;
  memoryUsage?: NodeJS.MemoryUsage;
  heapSizeLimitBytes?: number;
  processMemoryLimitBytes?: number;
  physicalMemoryBytes?: number;
  isBunRuntime?: boolean;
  uptimeMs?: number;
  thresholds?: DiagnosticMemoryThresholds;
  emitSample?: boolean;
}): DiagnosticMemoryUsage {
  const now = options?.now ?? Date.now();
  const memory = normalizeMemoryUsage(options?.memoryUsage ?? process.memoryUsage());
  const current = { ts: now, memory };
  const thresholds = resolveThresholds(
    options?.thresholds,
    options?.heapSizeLimitBytes ?? DEFAULT_HEAP_SIZE_LIMIT_BYTES,
    options?.processMemoryLimitBytes ?? DEFAULT_PROCESS_MEMORY_LIMIT_BYTES,
    options?.physicalMemoryBytes ?? DEFAULT_PHYSICAL_MEMORY_BYTES,
    options?.isBunRuntime ?? DEFAULT_IS_BUN_RUNTIME,
  );
  const shouldEmitSample = options?.emitSample !== false;

  if (shouldEmitSample) {
    emitDiagnosticEvent({
      type: "diagnostic.memory.sample",
      memory,
      uptimeMs: options?.uptimeMs ?? Math.round(process.uptime() * 1000),
    });
  }

  const growthPressure = pickGrowthPressure({ current, thresholds });
  const pressure = pickThresholdPressure({ memory, thresholds }) ?? growthPressure;
  if (pressure?.level === "critical") {
    channel("openclaw.memory.critical").publish(undefined);
  }
  if (pressure && shouldEmitPressure(pressure, now, thresholds.pressureRepeatMs)) {
    emitDiagnosticEvent({
      type: "diagnostic.memory.pressure",
      ...pressure,
    });
    logMemoryPressure(pressure);
  }
  return memory;
}

/** Clears process-local memory diagnostic state for isolated tests. */
export function resetDiagnosticMemoryForTest(): void {
  state.growth = null;
  state.lastPressureAtByKey.clear();
}

// The logging-core SDK shipped these optional inputs before automatic bundles retired.
export type EmitDiagnosticMemorySample = (
  options?: NonNullable<Parameters<typeof emitDiagnosticMemorySample>[0]> & {
    writeCriticalBundle?: boolean;
    stateDir?: string;
    sessionStorePaths?: string[];
    resolveSessionStorePaths?: () => string[] | undefined;
  },
) => ReturnType<typeof emitDiagnosticMemorySample>;
