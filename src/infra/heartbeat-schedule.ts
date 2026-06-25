// Computes deterministic heartbeat schedule phases and due times.
import { createHash } from "node:crypto";
import { resolveIntegerOption } from "./numeric-options.js";

function resolvePositiveIntervalMs(value: number): number {
  return resolveIntegerOption(value, 1, { min: 1 });
}

function normalizeModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

export function resolveHeartbeatPhaseMs(params: {
  schedulerSeed: string;
  agentId: string;
  intervalMs: number;
}) {
  const intervalMs = resolvePositiveIntervalMs(params.intervalMs);
  const digest = createHash("sha256").update(`${params.schedulerSeed}:${params.agentId}`).digest();
  return digest.readUInt32BE(0) % intervalMs;
}

export function computeNextHeartbeatPhaseDueMs(params: {
  nowMs: number;
  intervalMs: number;
  phaseMs: number;
}) {
  const intervalMs = resolvePositiveIntervalMs(params.intervalMs);
  const nowMs = Number.isFinite(params.nowMs) ? Math.floor(params.nowMs) : 0;
  const phaseMs = normalizeModulo(
    Number.isFinite(params.phaseMs) ? Math.floor(params.phaseMs) : 0,
    intervalMs,
  );
  const cyclePositionMs = normalizeModulo(nowMs, intervalMs);
  let deltaMs = normalizeModulo(phaseMs - cyclePositionMs, intervalMs);
  if (deltaMs === 0) {
    deltaMs = intervalMs;
  }
  return nowMs + deltaMs;
}

export function resolveNextHeartbeatDueMs(params: {
  nowMs: number;
  intervalMs: number;
  phaseMs: number;
  prev?: {
    intervalMs: number;
    phaseMs: number;
    nextDueMs: number;
  };
}) {
  const intervalMs = resolvePositiveIntervalMs(params.intervalMs);
  const phaseMs = normalizeModulo(
    Number.isFinite(params.phaseMs) ? Math.floor(params.phaseMs) : 0,
    intervalMs,
  );
  const prev = params.prev;
  if (
    prev &&
    prev.intervalMs === intervalMs &&
    prev.phaseMs === phaseMs &&
    prev.nextDueMs > params.nowMs
  ) {
    return prev.nextDueMs;
  }
  return computeNextHeartbeatPhaseDueMs({
    nowMs: params.nowMs,
    intervalMs,
    phaseMs,
  });
}

/**
 * Seek forward through phase-aligned slots until one falls within the active
 * hours window.  Falls back to the raw next slot when no predicate is provided
 * or no in-window slot is found within the seek horizon.
 *
 * The caller binds config/heartbeat into `isActive` so this module stays
 * config-agnostic.  `phaseMs` is unused — alignment is preserved because
 * `startMs` is already phase-aligned and `intervalMs` addition maintains it.
 */
const MAX_SEEK_HORIZON_MS = 7 * 24 * 60 * 60_000;
// Batch in whole-interval multiples ≥ 30 s so the iteration count stays
// ≤ 20,160 for every accepted interval.  The production isWithinActiveHours
// predicate does Intl.DateTimeFormat work per call; 20,160 calls ≈ 20–200 ms.
// Checking every phase candidate would cost up to 604,800 calls (0.6–6 s) for
// 1 s intervals — still tolerable once, but risky on startup/hot-reload.
const MIN_SEEK_STEP_MS = 30_000;

export function seekNextActivePhaseDueMs(params: {
  startMs: number;
  intervalMs: number;
  phaseMs: number;
  isActive?: (ms: number) => boolean;
}): number {
  const isActive = params.isActive;
  if (!isActive) {
    return params.startMs;
  }
  const intervalMs = resolvePositiveIntervalMs(params.intervalMs);
  const horizonMs = params.startMs + MAX_SEEK_HORIZON_MS;

  // Step in whole-interval multiples ≥ 30 s.  For intervalMs ≥ 30 s the
  // multiplier is 1 (effectively per-candidate).  For sub-30 s intervals
  // the batch step stays phase-aligned while keeping predicate calls ≤ 20,160.
  const multiplier = Math.max(1, Math.ceil(MIN_SEEK_STEP_MS / intervalMs));
  const batchStepMs = intervalMs * multiplier;

  let candidateMs = params.startMs;
  let prevWasActive: boolean | null = null;

  while (candidateMs <= horizonMs) {
    const active = isActive(candidateMs);
    if (active) {
      if (prevWasActive === false) {
        // Inactive→active transition: walk backward one batch step
        // to find the earliest phase-aligned slot inside the window.
        let first = candidateMs;
        let probe = candidateMs - intervalMs;
        const limit = Math.max(params.startMs, candidateMs - batchStepMs);
        while (probe > limit && isActive(probe)) {
          first = probe;
          probe -= intervalMs;
        }
        return first;
      }
      return candidateMs;
    }
    prevWasActive = active;
    candidateMs += batchStepMs;
  }

  // No in-window slot found; fall back so the runtime guard can gate it.
  return params.startMs;
}
