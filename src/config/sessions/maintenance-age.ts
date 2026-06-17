// Shared age floor for automatic session cleanup.
import type { SessionEntry } from "./types.js";

export const MIN_SESSION_CLEANUP_CANDIDATE_AGE_MS = 4 * 60 * 60 * 1000;

export type SessionCleanupAgeDecision =
  | {
      eligible: true;
      ageMs: number;
      minCandidateAgeMs: number;
      updatedAt: number;
    }
  | {
      eligible: false;
      reason: "under-age" | "age-unknown";
      ageMs?: number;
      minCandidateAgeMs: number;
      updatedAt?: number;
    };

export function resolveSessionCleanupMinCandidateAgeMs(overrideMs?: number): number {
  return typeof overrideMs === "number" && Number.isFinite(overrideMs) && overrideMs >= 0
    ? Math.max(overrideMs, MIN_SESSION_CLEANUP_CANDIDATE_AGE_MS)
    : MIN_SESSION_CLEANUP_CANDIDATE_AGE_MS;
}

export function resolveSessionCleanupCandidateAge(params: {
  entry: SessionEntry | undefined;
  nowMs?: number;
  minCandidateAgeMs?: number;
}): SessionCleanupAgeDecision {
  const minCandidateAgeMs = resolveSessionCleanupMinCandidateAgeMs(params.minCandidateAgeMs);
  const nowMs = params.nowMs ?? Date.now();
  const updatedAt = params.entry?.updatedAt;
  if (!Number.isFinite(updatedAt)) {
    return { eligible: false, reason: "age-unknown", minCandidateAgeMs };
  }
  const normalizedUpdatedAt = Number(updatedAt);
  if (normalizedUpdatedAt > nowMs) {
    return {
      eligible: false,
      reason: "age-unknown",
      minCandidateAgeMs,
      updatedAt: normalizedUpdatedAt,
    };
  }
  const ageMs = nowMs - normalizedUpdatedAt;
  if (ageMs < minCandidateAgeMs) {
    return {
      eligible: false,
      reason: "under-age",
      ageMs,
      minCandidateAgeMs,
      updatedAt: normalizedUpdatedAt,
    };
  }
  return { eligible: true, ageMs, minCandidateAgeMs, updatedAt: normalizedUpdatedAt };
}

export function resolveFileCleanupCandidateAge(params: {
  mtimeMs: number;
  nowMs?: number;
  minCandidateAgeMs?: number;
}): SessionCleanupAgeDecision {
  const minCandidateAgeMs = resolveSessionCleanupMinCandidateAgeMs(params.minCandidateAgeMs);
  const nowMs = params.nowMs ?? Date.now();
  if (!Number.isFinite(params.mtimeMs) || params.mtimeMs > nowMs) {
    return { eligible: false, reason: "age-unknown", minCandidateAgeMs };
  }
  const ageMs = nowMs - params.mtimeMs;
  if (ageMs < minCandidateAgeMs) {
    return {
      eligible: false,
      reason: "under-age",
      ageMs,
      minCandidateAgeMs,
      updatedAt: params.mtimeMs,
    };
  }
  return { eligible: true, ageMs, minCandidateAgeMs, updatedAt: params.mtimeMs };
}
