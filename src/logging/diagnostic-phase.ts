// Diagnostic phase helpers measure named phases and emit timing diagnostics.
import { performance } from "node:perf_hooks";
import {
  areDiagnosticsEnabledForProcess,
  emitDiagnosticEvent,
  type DiagnosticPhaseDetails,
  type DiagnosticPhaseSnapshot,
} from "../infra/diagnostic-events.js";

// Tracks nested diagnostic phases for recent-phase snapshots and optional event emission.
const RECENT_PHASE_CAPACITY = 40;

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
  return activePhaseStack.at(-1)?.name;
}

/**
 * Snapshot of an in-flight (not-yet-completed) diagnostic phase.
 *
 * `elapsedMs` is the wall-clock time between the phase entering
 * `withDiagnosticPhase` and the snapshot being taken.
 */
export type ActiveDiagnosticPhaseSnapshot = {
  name: string;
  elapsedMs: number;
};

/**
 * Returns a deep copy snapshot of every diagnostic phase currently on the
 * active stack, ordered outermost → innermost.
 *
 * Designed for diagnostic-only readers (e.g. the gateway startup watchdog)
 * that must observe the in-flight phase tree without retaining any reference
 * to the live mutable stack. The returned array and its members are fresh
 * objects — mutating them does not affect future phase tracking.
 *
 * Safe to call from a synchronous timer callback even when the event loop
 * is starved: the work is one stack walk plus N `performance.now()` reads.
 */
export function getActiveDiagnosticPhases(): ActiveDiagnosticPhaseSnapshot[] {
  const now = performance.now();
  return activePhaseStack.map((phase) => ({
    name: phase.name,
    elapsedMs: roundMetric(now - phase.startedWallMs, 1),
  }));
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

/** Records a completed phase in memory and emits it when diagnostics are enabled. */
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

/** Runs work inside a measured diagnostic phase with wall-clock and CPU metrics. */
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
    // Remove by identity so nested or overlapping phases do not corrupt the active stack.
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

/** Clears phase history and active stack for isolated tests. */
export function resetDiagnosticPhasesForTest(): void {
  activePhaseStack = [];
  recentPhases = [];
}
