import { performance } from "node:perf_hooks";
import { isTruthyEnvValue } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const restartTraceLog = createSubsystemLogger("gateway");

type RestartTraceMetricValue = boolean | number | string | null | undefined;
type RestartTraceMetrics =
  | Readonly<Record<string, RestartTraceMetricValue>>
  | ReadonlyArray<readonly [string, RestartTraceMetricValue]>;

let startedAt = 0;
let lastAt = 0;
let active = false;

function isRestartTraceEnabled(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_RESTART_TRACE);
}

function normalizeMetricEntries(
  metrics?: RestartTraceMetrics,
): Array<readonly [string, RestartTraceMetricValue]> {
  if (!metrics) {
    return [];
  }
  return Array.isArray(metrics) ? [...metrics] : Object.entries(metrics);
}

function formatMetricKey(key: string): string {
  const normalized = key.replace(/[^A-Za-z0-9]/gu, "");
  if (!normalized) {
    return "metric";
  }
  return /^[A-Za-z]/u.test(normalized) ? normalized : `metric${normalized}`;
}

function formatMetricValue(value: RestartTraceMetricValue): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toFixed(1) : null;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    const normalized = value
      .trim()
      .replace(/\s+/gu, "_")
      .replace(/[^A-Za-z0-9_.:/-]/gu, "_")
      .slice(0, 120);
    return normalized || null;
  }
  return null;
}

function formatMetrics(metrics?: RestartTraceMetrics): string {
  const parts: string[] = [];
  for (const [key, value] of normalizeMetricEntries(metrics)) {
    const formatted = formatMetricValue(value);
    if (formatted === null) {
      continue;
    }
    parts.push(`${formatMetricKey(key)}=${formatted}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function emitRestartTrace(
  name: string,
  durationMs: number,
  totalMs: number,
  metrics?: RestartTraceMetrics,
) {
  restartTraceLog.info(
    `restart trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms${formatMetrics(metrics)}`,
  );
}

function emitRestartTraceDetail(name: string, metrics: RestartTraceMetrics): void {
  const formatted = formatMetrics(metrics).trim();
  if (!formatted) {
    return;
  }
  restartTraceLog.info(`restart trace: ${name} ${formatted}`);
}

export function startGatewayRestartTrace(name: string, metrics?: RestartTraceMetrics): void {
  if (!isRestartTraceEnabled()) {
    active = false;
    return;
  }
  const now = performance.now();
  startedAt = now;
  lastAt = now;
  active = true;
  emitRestartTrace(name, 0, 0, metrics);
}

function isGatewayRestartTraceActive(): boolean {
  return isRestartTraceEnabled() && active;
}

export function markGatewayRestartTrace(name: string, metrics?: RestartTraceMetrics): void {
  if (!isGatewayRestartTraceActive()) {
    return;
  }
  const now = performance.now();
  emitRestartTrace(name, now - lastAt, now - startedAt, metrics);
  lastAt = now;
}

export function finishGatewayRestartTrace(name: string, metrics?: RestartTraceMetrics): void {
  markGatewayRestartTrace(name, metrics);
  active = false;
}

export async function measureGatewayRestartTrace<T>(
  name: string,
  run: () => Promise<T> | T,
  metrics?: RestartTraceMetrics | (() => RestartTraceMetrics | undefined),
): Promise<T> {
  if (!isGatewayRestartTraceActive()) {
    return await run();
  }
  const before = performance.now();
  try {
    return await run();
  } finally {
    const now = performance.now();
    emitRestartTrace(
      name,
      now - before,
      now - startedAt,
      typeof metrics === "function" ? metrics() : metrics,
    );
    lastAt = now;
  }
}

export function recordGatewayRestartTrace(
  name: string,
  durationMs: number,
  metrics?: RestartTraceMetrics,
): void {
  if (!isGatewayRestartTraceActive() || !Number.isFinite(durationMs)) {
    return;
  }
  const now = performance.now();
  emitRestartTrace(name, Math.max(0, durationMs), now - startedAt, metrics);
  lastAt = now;
}

export function recordGatewayRestartTraceSpan(
  name: string,
  durationMs: number,
  totalMs: number,
  metrics?: RestartTraceMetrics,
): void {
  if (!isGatewayRestartTraceActive() || !Number.isFinite(durationMs) || !Number.isFinite(totalMs)) {
    return;
  }
  emitRestartTrace(name, Math.max(0, durationMs), Math.max(0, totalMs), metrics);
}

export function recordGatewayRestartTraceDetail(name: string, metrics: RestartTraceMetrics): void {
  if (!isGatewayRestartTraceActive()) {
    return;
  }
  emitRestartTraceDetail(name, metrics);
}

export function collectGatewayProcessMemoryUsageMb(): ReadonlyArray<readonly [string, number]> {
  const usage = process.memoryUsage();
  const toMb = (bytes: number) => bytes / 1024 / 1024;
  return [
    ["rssMb", toMb(usage.rss)],
    ["heapTotalMb", toMb(usage.heapTotal)],
    ["heapUsedMb", toMb(usage.heapUsed)],
    ["externalMb", toMb(usage.external)],
    ["arrayBuffersMb", toMb(usage.arrayBuffers)],
  ];
}

export function resetGatewayRestartTraceForTest(): void {
  startedAt = 0;
  lastAt = 0;
  active = false;
}
