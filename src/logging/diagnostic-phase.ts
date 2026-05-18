import { performance } from "node:perf_hooks";
import {
  areDiagnosticsEnabledForProcess,
  emitDiagnosticEvent,
  type DiagnosticPhaseDetails,
  type DiagnosticPhaseSnapshot,
} from "../infra/diagnostic-events.js";

const RECENT_PHASE_CAPACITY = 40;

/**
 * Maximum wall-clock time a diagnostic phase may remain on the active stack
 * before it is automatically evicted during the next `getCurrentDiagnosticPhase`
 * call. This prevents long-running tasks (e.g. channel polling loops that were
 * accidentally wrapped in `withDiagnosticPhase`) from holding a stale phase
 * entry indefinitely, which causes the liveness monitor to report the gateway
 * event loop as "degraded" even when the channel is functional.
 *
 * When a phase exceeds this deadline it is removed from `activePhaseStack` and
 * recorded with a synthetic completion snapshot so it still appears in
 * `recentPhases` for observability.
 */
const DIAGNOSTIC_PHASE_MAX_LIFETIME_MS = 5 * 60_000;

type ActiveDiagnosticPhase = {
  name: string;
  startedAt: number;
  startedWallMs: number;
  cpuStarted: NodeJS.CpuUsage;
  details?: DiagnosticPhaseDetails;
};

let activePhaseStack: ActiveDiagnosticPhase[] = [];
let recentPhases: DiagnosticPhaseSnapshot[] = [];

function roundMetric(value: number, digits = 1): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pushRecentPhase(snapshot: DiagnosticPhaseSnapshot): void {
  recentPhases.push(snapshot);
  if (recentPhases.length > RECENT_PHASE_CAPACITY) {
    recentPhases = recentPhases.slice(-RECENT_PHASE_CAPACITY);
  }
}

export function getCurrentDiagnosticPhase(): string | undefined {
  evictStalePhases();
  return activePhaseStack.at(-1)?.name;
}

/**
 * Remove any phases that have been active longer than
 * `DIAGNOSTIC_PHASE_MAX_LIFETIME_MS`. Evicted phases are recorded as completed
 * with a synthetic snapshot so they remain visible in `recentPhases`.
 */
function evictStalePhases(): void {
  if (activePhaseStack.length === 0) {
    return;
  }
  const nowMs = performance.now();
  const evicted: ActiveDiagnosticPhase[] = [];
  activePhaseStack = activePhaseStack.filter((entry) => {
    const elapsed = nowMs - entry.startedWallMs;
    if (elapsed > DIAGNOSTIC_PHASE_MAX_LIFETIME_MS) {
      evicted.push(entry);
      return false;
    }
    return true;
  });
  for (const entry of evicted) {
    const durationMs = roundMetric(nowMs - entry.startedWallMs, 1);
    const cpu = process.cpuUsage(entry.cpuStarted);
    const cpuUserMs = roundMetric(cpu.user / 1_000, 1);
    const cpuSystemMs = roundMetric(cpu.system / 1_000, 1);
    const cpuTotalMs = roundMetric(cpuUserMs + cpuSystemMs, 1);
    recordDiagnosticPhase({
      name: entry.name,
      startedAt: entry.startedAt,
      endedAt: Date.now(),
      durationMs,
      cpuUserMs,
      cpuSystemMs,
      cpuTotalMs,
      cpuCoreRatio: roundMetric(cpuTotalMs / Math.max(1, durationMs), 3),
      details: { ...entry.details, evicted: true },
    });
  }
}

function resolveRecentPhaseLimit(limit: number): number | null {
  if (!Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  return Math.floor(limit);
}

export function getRecentDiagnosticPhases(limit = 8): DiagnosticPhaseSnapshot[] {
  const resolved = resolveRecentPhaseLimit(limit);
  if (resolved === null) {
    return [];
  }
  return recentPhases.slice(-resolved).map((phase) => Object.assign({}, phase));
}

export function recordDiagnosticPhase(snapshot: DiagnosticPhaseSnapshot): void {
  pushRecentPhase(snapshot);
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  emitDiagnosticEvent({
    type: "diagnostic.phase.completed",
    ...snapshot,
  });
}

export async function withDiagnosticPhase<T>(
  name: string,
  run: () => Promise<T> | T,
  details?: DiagnosticPhaseDetails,
): Promise<T> {
  const active: ActiveDiagnosticPhase = {
    name,
    startedAt: Date.now(),
    startedWallMs: performance.now(),
    cpuStarted: process.cpuUsage(),
    details,
  };
  activePhaseStack.push(active);
  try {
    return await run();
  } finally {
    const endedAt = Date.now();
    const durationMs = roundMetric(performance.now() - active.startedWallMs, 1);
    const cpu = process.cpuUsage(active.cpuStarted);
    const cpuUserMs = roundMetric(cpu.user / 1_000, 1);
    const cpuSystemMs = roundMetric(cpu.system / 1_000, 1);
    const cpuTotalMs = roundMetric(cpuUserMs + cpuSystemMs, 1);
    activePhaseStack = activePhaseStack.filter((entry) => entry !== active);
    recordDiagnosticPhase({
      name,
      startedAt: active.startedAt,
      endedAt,
      durationMs,
      cpuUserMs,
      cpuSystemMs,
      cpuTotalMs,
      cpuCoreRatio: roundMetric(cpuTotalMs / Math.max(1, durationMs), 3),
      details: active.details,
    });
  }
}

export function resetDiagnosticPhasesForTest(): void {
  activePhaseStack = [];
  recentPhases = [];
}
