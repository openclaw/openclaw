// Trajectory writer lifecycle owns per-canonical-path generation/ownership so
// flush/rename (runtime.ts) and delete/retire (cleanup.ts) serialize through
// one registry instead of three uncoordinated primitives (writers-map
// eviction, the old windowFlushes queue, and delete's raw fs.rm).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { createSubsystemLogger } from "../logging/subsystem.js";

type TrajectoryPathEntry = {
  generation: number;
  ownerSessionId: string;
  retired: boolean;
  retiredAtMs?: number;
};

const TRAJECTORY_REGISTRY_RETIRED_GRACE_MS = 5 * 60 * 1000;
const TRAJECTORY_REGISTRY_MAX_ENTRIES = 10_000;

const log = createSubsystemLogger("trajectory/writer-lifecycle");
const registry = new Map<string, TrajectoryPathEntry>();
const pathQueue = new KeyedAsyncQueue();

/** Canonical registry key: resolved + best-effort realpath'd, shared with cleanup.ts. */
export function canonicalizeTrajectoryPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function disambiguateTrajectoryCandidatePath(candidatePath: string, sessionId: string): string {
  const suffix = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
  return candidatePath.endsWith(".jsonl")
    ? `${candidatePath.slice(0, -".jsonl".length)}-${suffix}.jsonl`
    : `${candidatePath}-${suffix}.jsonl`;
}

/**
 * Resolves a candidate path to its registered filePath/generation, disambiguating a
 * sanitized-name collision against a different live/retired owner. Synchronous and
 * non-yielding by design: a claim can never interleave with a concurrent retirement
 * of the same path, since neither touches the registry across an `await` boundary.
 */
export function acquireTrajectoryWriterLease(params: {
  sessionId: string;
  candidatePath: string;
}): { filePath: string; generation: number } {
  let candidatePath = params.candidatePath;
  for (;;) {
    const canonicalPath = canonicalizeTrajectoryPath(candidatePath);
    const existing = registry.get(canonicalPath);
    if (!existing) {
      registry.set(canonicalPath, {
        generation: 1,
        ownerSessionId: params.sessionId,
        retired: false,
      });
      return { filePath: candidatePath, generation: 1 };
    }
    if (existing.ownerSessionId === params.sessionId) {
      if (!existing.retired) {
        return { filePath: candidatePath, generation: existing.generation };
      }
      const generation = existing.generation + 1;
      registry.set(canonicalPath, {
        generation,
        ownerSessionId: params.sessionId,
        retired: false,
      });
      return { filePath: candidatePath, generation };
    }
    // Different owner already holds this canonical path: disambiguate rather
    // than share a file between two unrelated sessions (F4/F6).
    candidatePath = disambiguateTrajectoryCandidatePath(candidatePath, params.sessionId);
  }
}

/**
 * THE serialized boundary for a trajectory path. Both the flush/rename path and the
 * delete/retire path go through this, so a stale-generation write can never land
 * after a retirement decided in an earlier turn for the same canonical path.
 */
export async function withTrajectoryPathLock<T>(
  canonicalPath: string,
  fn: (ctx: { currentGeneration: number; retired: boolean }) => Promise<T> | T,
): Promise<T> {
  return await pathQueue.enqueue(canonicalPath, async () => {
    const entry = registry.get(canonicalPath);
    return await fn({
      currentGeneration: entry?.generation ?? 0,
      retired: entry?.retired ?? false,
    });
  });
}

/**
 * Must only be called from inside a withTrajectoryPathLock(canonicalPath, ...) turn.
 * ownerSessionId defaults to the existing entry's owner so a retire call that races
 * ahead of any writer created in this process (e.g. deleting a session whose
 * trajectory writer lived in a prior process run) still records who owned the path,
 * which is required for that owner's later resurrection to reuse the path instead of
 * hitting the collision-disambiguation branch.
 */
export function bumpTrajectoryPathGeneration(
  canonicalPath: string,
  opts: { retire: boolean; ownerSessionId?: string },
): number {
  const existing = registry.get(canonicalPath);
  const generation = (existing?.generation ?? 0) + 1;
  registry.set(canonicalPath, {
    generation,
    ownerSessionId: opts.ownerSessionId ?? existing?.ownerSessionId ?? "",
    retired: opts.retire,
    retiredAtMs: opts.retire ? Date.now() : undefined,
  });
  return generation;
}

/**
 * Reassigns a still-live (non-retired) path to a new owner without a generation bump,
 * for the resetSessionEntryLifecycle "reused transcript path" case: the file and any
 * in-flight writer for it remain valid, only the logical owner changes (§3.6).
 */
export function reassignTrajectoryPathOwner(
  canonicalPath: string,
  params: { from: string; to: string },
): void {
  const existing = registry.get(canonicalPath);
  if (!existing || existing.retired || existing.ownerSessionId !== params.from) {
    return;
  }
  registry.set(canonicalPath, { ...existing, ownerSessionId: params.to });
}

/**
 * Opportunistic/lazy reap: retired entries must survive a grace period (comfortably
 * above the cleanup-step flush timeout) so a late-arriving stale flush still finds a
 * "retired" entry rather than an absent one that would be wrongly treated as fresh.
 * Piggybacks on trimTrajectoryWriterCache's call site instead of a timer/interval.
 */
export function reapRetiredTrajectoryPathEntries(): void {
  const nowMs = Date.now();
  for (const [canonicalPath, entry] of registry) {
    if (
      entry.retired &&
      entry.retiredAtMs !== undefined &&
      nowMs - entry.retiredAtMs > TRAJECTORY_REGISTRY_RETIRED_GRACE_MS
    ) {
      registry.delete(canonicalPath);
    }
  }
  if (registry.size <= TRAJECTORY_REGISTRY_MAX_ENTRIES) {
    return;
  }
  const retiredByAge = [...registry.entries()]
    .filter(([, entry]) => entry.retired)
    .toSorted((left, right) => (left[1].retiredAtMs ?? 0) - (right[1].retiredAtMs ?? 0));
  for (const [canonicalPath, entry] of retiredByAge) {
    if (registry.size <= TRAJECTORY_REGISTRY_MAX_ENTRIES) {
      break;
    }
    log.warn(
      `trajectory writer registry backstop evicted a retired path before its grace period: ${canonicalPath} (retired ${Math.round((nowMs - (entry.retiredAtMs ?? nowMs)) / 1000)}s ago)`,
    );
    registry.delete(canonicalPath);
  }
}

export function clearTrajectoryWriterLifecycleRegistryForTest(): void {
  registry.clear();
}

export function getTrajectoryPathRegistryEntryForTest(
  canonicalPath: string,
): Readonly<TrajectoryPathEntry> | undefined {
  return registry.get(canonicalPath);
}
