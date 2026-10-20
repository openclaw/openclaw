import { performance } from "node:perf_hooks";
import { createQueuedDiagnosticPhaseEmitter } from "./diagnostic-events.js";
import { hasNodeErrorCode } from "./path-guards.js";

const DIFF_READ_STAGES = [
  "admission",
  "checkout-resolve",
  "cache-validate",
  "worker-queue",
  "git-wall",
  "encode",
] as const;
type DiffReadStage = (typeof DIFF_READ_STAGES)[number];

type DiffRevisionUnavailableReason =
  | "oversized"
  | "no-revision-environment"
  | "no-revision-platform"
  | "no-revision-metadata"
  | "no-revision-git-installation"
  | "no-revision-config"
  | "no-revision-reftable"
  | "no-revision-alternates"
  | "no-revision-symlink"
  | "no-revision-nested-repository"
  | "no-revision-status"
  | "no-revision-unmerged"
  | "no-revision-submodule"
  | "no-revision-permission"
  | "no-revision-missing"
  | "no-revision-io";

export type DiffReadCacheMissReason =
  | "cold"
  | "evicted"
  | "pending"
  | "no-revision"
  | DiffRevisionUnavailableReason
  | "revision-changed-head"
  | "revision-changed-index"
  | "revision-changed-untracked-set"
  | "revision-changed-worktree-mtime"
  | "revision-changed-metadata";

export type DiffReadTiming = {
  durations: Partial<Record<DiffReadStage, number>>;
  outcome?: "cache-hit" | "cache-miss";
  missReason?: DiffReadCacheMissReason;
  revisionUnavailableReason?: DiffRevisionUnavailableReason;
};

export function unavailableDiffRevision(
  timing: DiffReadTiming | undefined,
  reason?: DiffRevisionUnavailableReason,
  error?: unknown,
): null {
  if (timing) {
    timing.revisionUnavailableReason =
      reason ??
      timing.revisionUnavailableReason ??
      (hasNodeErrorCode(error, "EACCES") || hasNodeErrorCode(error, "EPERM")
        ? "no-revision-permission"
        : hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")
          ? "no-revision-missing"
          : "no-revision-io");
  }
  return null;
}

export function addDiffReadDurations(target: DiffReadTiming, source: DiffReadTiming) {
  for (const stage of DIFF_READ_STAGES) {
    const duration = source.durations[stage];
    if (duration !== undefined) {
      target.durations[stage] = (target.durations[stage] ?? 0) + duration;
    }
  }
}

export function startDiffReadTiming(
  operation: "sessions.diff" | "checkout.diff",
  started = performance.now(),
) {
  const emit = createQueuedDiagnosticPhaseEmitter();
  if (!emit) {
    return undefined;
  }
  const timing: DiffReadTiming = { durations: { "worker-queue": 0, "git-wall": 0 } };
  return {
    ...timing,
    [Symbol.dispose]() {
      // Only completed local cache reads have a cache outcome. Remote and failed reads
      // retain the normal RPC diagnostics instead of masquerading as cache misses.
      if (!this.outcome) {
        return;
      }
      try {
        const ended = performance.now();
        emit({
          name: operation,
          startedAt: performance.timeOrigin + started,
          durationMs: ended - started,
          details: {
            ...this.durations,
            outcome: this.outcome,
            ...(this.missReason ? { missReason: this.missReason } : {}),
          },
        });
      } catch {
        // Telemetry cannot replace the response or original error.
      }
    },
  };
}
