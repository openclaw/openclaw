import { createHash } from "node:crypto";

function normalizeModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

export function resolveHeartbeatPhaseMs(params: {
  schedulerSeed: string;
  agentId: string;
  intervalMs: number;
}) {
  const intervalMs = Math.max(1, Math.floor(params.intervalMs));
  const digest = createHash("sha256").update(`${params.schedulerSeed}:${params.agentId}`).digest();
  return digest.readUInt32BE(0) % intervalMs;
}

export function computeNextHeartbeatPhaseDueMs(params: {
  nowMs: number;
  intervalMs: number;
  phaseMs: number;
}) {
  const intervalMs = Math.max(1, Math.floor(params.intervalMs));
  const nowMs = Math.floor(params.nowMs);
  const phaseMs = normalizeModulo(Math.floor(params.phaseMs), intervalMs);
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
  const intervalMs = Math.max(1, Math.floor(params.intervalMs));
  const phaseMs = normalizeModulo(Math.floor(params.phaseMs), intervalMs);
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
 * hours window.  Returns the first in-window slot, or falls back to the raw
 * next slot when no active hours are configured or no in-window slot is found
 * within the seek horizon.
 *
 * `isActive` is a predicate that mirrors `isWithinActiveHours` — the caller
 * binds the config/heartbeat so this module stays config-agnostic.
 */
const MAX_SEEK_HORIZON_MS = 7 * 24 * 60 * 60_000; // 7 days

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
  const intervalMs = Math.max(1, Math.floor(params.intervalMs));
  const horizonMs = params.startMs + MAX_SEEK_HORIZON_MS;
  let candidateMs = params.startMs;
  while (candidateMs <= horizonMs) {
    if (isActive(candidateMs)) {
      return candidateMs;
    }
    candidateMs += intervalMs;
  }
  // All slots within the seek horizon fall outside active hours — return the
  // raw first slot so the runtime execution guard can still gate it.
  return params.startMs;
}
