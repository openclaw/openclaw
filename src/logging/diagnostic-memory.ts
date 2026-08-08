// Diagnostic memory helpers capture process memory facts for support diagnostics.
import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import {
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
  type DiagnosticMemoryPressureEvent,
  type DiagnosticMemoryUsage,
} from "../infra/diagnostic-events.js";
import { writeDiagnosticMemoryPressureBundleSync } from "./diagnostic-stability-bundle.js";
import { createSubsystemLogger } from "./subsystem.js";

// Diagnostic memory sampler with threshold/growth pressure detection and repeat suppression.
const MB = 1024 * 1024;
const GB = 1024 * MB;
const DEFAULT_RSS_WARNING_BYTES = 1536 * MB;
const DEFAULT_RSS_CRITICAL_BYTES = 3072 * MB;
const DEFAULT_RSS_WARNING_RATIO = 0.75;
const DEFAULT_RSS_CRITICAL_RATIO = 1.5;
const DEFAULT_RSS_WARNING_MAX_BYTES = 6 * GB;
const DEFAULT_RSS_CRITICAL_MAX_BYTES = 12 * GB;
// A scaled RSS threshold is only useful if the host can actually reach it, so
// cap both levels against total memory as well. Without this, a container whose
// V8 limit equals its memory limit would compute a critical threshold it can
// never hit, and would OOM with no diagnostic ever emitted.
const DEFAULT_RSS_WARNING_HOST_RATIO = 0.5;
const DEFAULT_RSS_CRITICAL_HOST_RATIO = 0.75;
const DEFAULT_HEAP_WARNING_BYTES = 1024 * MB;
const DEFAULT_HEAP_CRITICAL_BYTES = 2048 * MB;
const DEFAULT_HEAP_WARNING_RATIO = 0.5;
const DEFAULT_HEAP_CRITICAL_RATIO = 0.75;
const DEFAULT_HEAP_WARNING_MAX_BYTES = 4 * GB;
const DEFAULT_HEAP_CRITICAL_MAX_BYTES = 6 * GB;
const DEFAULT_RSS_GROWTH_WARNING_BYTES = 512 * MB;
const DEFAULT_RSS_GROWTH_CRITICAL_BYTES = 1024 * MB;
const DEFAULT_GROWTH_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_PRESSURE_REPEAT_MS = 5 * 60 * 1000;
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

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
  lastSample: DiagnosticMemorySample | null;
  lastPressureAtByKey: Map<string, number>;
};

const state: DiagnosticMemoryState = {
  lastSample: null,
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
  };
}

/**
 * Memory the process is actually allowed to use.
 *
 * Mirrors `readAvailableMemory` in `src/daemon/gateway-heap.ts`: prefer the
 * OS-imposed constraint, but only when it is a real constraint. cgroup reports
 * an effectively unlimited quota as an oversized finite value, so a limit above
 * physical memory is rejected rather than trusted - accepting it would select
 * ceilings the host can never reach and lose the critical signal before OOM.
 *
 * Both inputs are injectable so the default path itself is testable.
 */
function resolveMemoryLimitBytes(inputs?: {
  constrainedMemoryBytes?: number;
  physicalMemoryBytes?: number;
}): number {
  const constrained = inputs?.constrainedMemoryBytes ?? process.constrainedMemory?.();
  const physical = inputs?.physicalMemoryBytes ?? totalmem();
  if (
    typeof constrained === "number" &&
    Number.isFinite(constrained) &&
    constrained > 0 &&
    constrained <= physical
  ) {
    return constrained;
  }
  return physical;
}

function resolveThresholds(
  thresholds?: DiagnosticMemoryThresholds,
  heapSizeLimitBytes?: number,
  memoryLimitBytes?: number,
): Required<DiagnosticMemoryThresholds> {
  const hasHeapLimit =
    typeof heapSizeLimitBytes === "number" &&
    Number.isFinite(heapSizeLimitBytes) &&
    heapSizeLimitBytes > 0;
  const hasMemoryLimit =
    typeof memoryLimitBytes === "number" &&
    Number.isFinite(memoryLimitBytes) &&
    memoryLimitBytes > 0;
  // Cap the scaled thresholds by what the process may actually use, but never
  // below the historical flat defaults: a small host must not start warning
  // EARLIER than it did before this scaling existed. Floor first, then cap.
  const rssWarningCeiling = hasMemoryLimit
    ? Math.max(
        DEFAULT_RSS_WARNING_BYTES,
        Math.min(
          DEFAULT_RSS_WARNING_MAX_BYTES,
          Math.floor(memoryLimitBytes * DEFAULT_RSS_WARNING_HOST_RATIO),
        ),
      )
    : DEFAULT_RSS_WARNING_MAX_BYTES;
  const rssCriticalCeiling = hasMemoryLimit
    ? Math.max(
        DEFAULT_RSS_CRITICAL_BYTES,
        Math.min(
          DEFAULT_RSS_CRITICAL_MAX_BYTES,
          Math.floor(memoryLimitBytes * DEFAULT_RSS_CRITICAL_HOST_RATIO),
        ),
      )
    : DEFAULT_RSS_CRITICAL_MAX_BYTES;
  // Scale both directions with V8's effective limit, but keep a warning/critical
  // ceiling so very large heaps still surface actionable pressure diagnostics.
  const heapWarningBytes = hasHeapLimit
    ? Math.min(
        Math.floor(heapSizeLimitBytes * DEFAULT_HEAP_WARNING_RATIO),
        DEFAULT_HEAP_WARNING_MAX_BYTES,
      )
    : DEFAULT_HEAP_WARNING_BYTES;
  const heapCriticalBytes = hasHeapLimit
    ? Math.min(
        Math.floor(heapSizeLimitBytes * DEFAULT_HEAP_CRITICAL_RATIO),
        DEFAULT_HEAP_CRITICAL_MAX_BYTES,
      )
    : DEFAULT_HEAP_CRITICAL_BYTES;
  // RSS is heap plus native overhead, so it has to scale with the same limit the
  // heap thresholds already track. The flat defaults act as a floor, which keeps
  // small hosts on exactly their previous thresholds (a 2 GiB heap limit still
  // warns at 1.5 GiB) while a host sized for a large heap stops reporting its
  // own configured working set as pressure. The ceilings keep very large heaps
  // from disabling the signal entirely, and are themselves bounded by total
  // memory so a threshold is never placed where the host cannot reach it.
  const rssWarningBytes = hasHeapLimit
    ? Math.min(
        Math.max(
          Math.floor(heapSizeLimitBytes * DEFAULT_RSS_WARNING_RATIO),
          DEFAULT_RSS_WARNING_BYTES,
        ),
        rssWarningCeiling,
      )
    : DEFAULT_RSS_WARNING_BYTES;
  const rssCriticalBytes = hasHeapLimit
    ? Math.min(
        Math.max(
          Math.floor(heapSizeLimitBytes * DEFAULT_RSS_CRITICAL_RATIO),
          DEFAULT_RSS_CRITICAL_BYTES,
        ),
        rssCriticalCeiling,
      )
    : DEFAULT_RSS_CRITICAL_BYTES;
  return {
    rssWarningBytes: thresholds?.rssWarningBytes ?? rssWarningBytes,
    rssCriticalBytes: thresholds?.rssCriticalBytes ?? rssCriticalBytes,
    heapUsedWarningBytes: thresholds?.heapUsedWarningBytes ?? heapWarningBytes,
    heapUsedCriticalBytes: thresholds?.heapUsedCriticalBytes ?? heapCriticalBytes,
    rssGrowthWarningBytes: thresholds?.rssGrowthWarningBytes ?? DEFAULT_RSS_GROWTH_WARNING_BYTES,
    rssGrowthCriticalBytes: thresholds?.rssGrowthCriticalBytes ?? DEFAULT_RSS_GROWTH_CRITICAL_BYTES,
    growthWindowMs: thresholds?.growthWindowMs ?? DEFAULT_GROWTH_WINDOW_MS,
    pressureRepeatMs: thresholds?.pressureRepeatMs ?? DEFAULT_PRESSURE_REPEAT_MS,
  };
}

function pickThresholdPressure(params: {
  memory: DiagnosticMemoryUsage;
  thresholds: Required<DiagnosticMemoryThresholds>;
}): Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type"> | null {
  const { memory, thresholds } = params;
  if (memory.rssBytes >= thresholds.rssCriticalBytes) {
    return {
      level: "critical",
      reason: "rss_threshold",
      memory,
      thresholdBytes: thresholds.rssCriticalBytes,
    };
  }
  if (memory.heapUsedBytes >= thresholds.heapUsedCriticalBytes) {
    return {
      level: "critical",
      reason: "heap_threshold",
      memory,
      thresholdBytes: thresholds.heapUsedCriticalBytes,
    };
  }
  if (memory.rssBytes >= thresholds.rssWarningBytes) {
    return {
      level: "warning",
      reason: "rss_threshold",
      memory,
      thresholdBytes: thresholds.rssWarningBytes,
    };
  }
  if (memory.heapUsedBytes >= thresholds.heapUsedWarningBytes) {
    return {
      level: "warning",
      reason: "heap_threshold",
      memory,
      thresholdBytes: thresholds.heapUsedWarningBytes,
    };
  }
  return null;
}

function pickGrowthPressure(params: {
  previous: DiagnosticMemorySample | null;
  current: DiagnosticMemorySample;
  thresholds: Required<DiagnosticMemoryThresholds>;
}): Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type"> | null {
  const { previous, current, thresholds } = params;
  if (!previous) {
    return null;
  }
  const windowMs = current.ts - previous.ts;
  if (windowMs <= 0 || windowMs > thresholds.growthWindowMs) {
    return null;
  }
  const rssGrowthBytes = current.memory.rssBytes - previous.memory.rssBytes;
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

function formatPressureNextStep(
  pressure: Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type">,
): string {
  return pressure.level === "critical"
    ? "nextStep=inspect latest stability bundle or run openclaw gateway diagnostics export; restart gateway if process is unstable"
    : "nextStep=run openclaw gateway status --deep and openclaw gateway diagnostics export; restart gateway if pressure persists";
}

function logMemoryPressure(params: {
  pressure: Omit<DiagnosticMemoryPressureEvent, "seq" | "ts" | "type">;
  writeCriticalBundle: boolean;
}): void {
  const { pressure } = params;
  const message =
    `memory pressure: level=${pressure.level} reason=${pressure.reason}` +
    ` ${formatPressureSummary(pressure)}` +
    ` rssBytes=${pressure.memory.rssBytes}` +
    ` heapUsedBytes=${pressure.memory.heapUsedBytes}` +
    formatOptionalPressureMetric("thresholdBytes", pressure.thresholdBytes) +
    formatOptionalPressureMetric("rssGrowthBytes", pressure.rssGrowthBytes) +
    formatOptionalPressureMetric("windowMs", pressure.windowMs) +
    (pressure.level === "critical"
      ? ` memoryPressureSnapshot=${params.writeCriticalBundle ? "enabled" : "disabled"}`
      : "") +
    ` ${formatPressureNextStep(pressure)}`;
  log.warn(message);
}

export function emitDiagnosticMemorySample(options?: {
  now?: number;
  memoryUsage?: NodeJS.MemoryUsage;
  heapSizeLimitBytes?: number;
  memoryLimitBytes?: number;
  constrainedMemoryBytes?: number;
  physicalMemoryBytes?: number;
  uptimeMs?: number;
  thresholds?: DiagnosticMemoryThresholds;
  emitSample?: boolean;
  writeCriticalBundle?: boolean;
  stateDir?: string;
  sessionStorePaths?: string[];
  resolveSessionStorePaths?: () => string[] | undefined;
}): DiagnosticMemoryUsage {
  const now = options?.now ?? Date.now();
  const memory = normalizeMemoryUsage(options?.memoryUsage ?? process.memoryUsage());
  const current = { ts: now, memory };
  const thresholds = resolveThresholds(
    options?.thresholds,
    options?.heapSizeLimitBytes ?? getHeapStatistics().heap_size_limit,
    options?.memoryLimitBytes ??
      resolveMemoryLimitBytes({
        constrainedMemoryBytes: options?.constrainedMemoryBytes,
        physicalMemoryBytes: options?.physicalMemoryBytes,
      }),
  );
  const shouldEmitSample = options?.emitSample !== false;

  if (shouldEmitSample) {
    emitDiagnosticEvent({
      type: "diagnostic.memory.sample",
      memory,
      uptimeMs: options?.uptimeMs ?? Math.round(process.uptime() * 1000),
    });
  }

  const pressure =
    pickThresholdPressure({ memory, thresholds }) ??
    pickGrowthPressure({ previous: state.lastSample, current, thresholds });
  state.lastSample = current;
  if (pressure && shouldEmitPressure(pressure, now, thresholds.pressureRepeatMs)) {
    emitDiagnosticEvent({
      type: "diagnostic.memory.pressure",
      ...pressure,
    });
    const writeCriticalBundle = options?.writeCriticalBundle === true;
    logMemoryPressure({ pressure, writeCriticalBundle });
    if (pressure.level === "critical" && writeCriticalBundle) {
      // Critical snapshots are opt-in because bundle writes can add IO during memory pressure.
      const sessionStorePaths = options?.sessionStorePaths ?? options?.resolveSessionStorePaths?.();
      const result = writeDiagnosticMemoryPressureBundleSync({
        pressure,
        stateDir: options?.stateDir,
        sessionStorePaths,
        now: new Date(now),
      });
      if (result.status === "written") {
        log.warn(
          `critical memory pressure bundle written: path=${result.path} reason=${pressure.reason} level=${pressure.level}`,
        );
      } else if (result.status === "failed") {
        log.warn(`critical memory pressure bundle failed: ${String(result.error)}`);
      }
    } else if (pressure.level === "critical") {
      log.warn("critical memory pressure snapshot disabled");
    }
  }
  return memory;
}

/** Clears process-local memory diagnostic state for isolated tests. */
export function resetDiagnosticMemoryForTest(): void {
  state.lastSample = null;
  state.lastPressureAtByKey.clear();
}
