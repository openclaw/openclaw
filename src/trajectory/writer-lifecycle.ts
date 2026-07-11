// Trajectory writer lifecycle owns per-canonical-path incarnation/ownership so
// acquisition (runtime.ts), flush/rename (runtime.ts), and delete/retire
// (cleanup.ts) all serialize through one registry and one lock instead of
// racing through independent primitives (writers-map eviction, the old
// windowFlushes queue, and delete's raw fs.rm).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { createSubsystemLogger } from "../logging/subsystem.js";

type TrajectoryPathEntry = {
  // Process-unique, monotonically increasing, never reused — including across
  // a reap of this same canonical path. A per-path counter that restarts at 1
  // after reap would let a long-held stale writer from a fully retired-and-
  // reaped epoch validate against a brand new owner's claim (P1-B).
  incarnation: number;
  ownerSessionId: string;
  retired: boolean;
  retiredAtMs?: number;
};

const TRAJECTORY_REGISTRY_RETIRED_GRACE_MS = 5 * 60 * 1000;
const TRAJECTORY_REGISTRY_MAX_ENTRIES = 10_000;

const log = createSubsystemLogger("trajectory/writer-lifecycle");
const registry = new Map<string, TrajectoryPathEntry>();
const pathQueue = new KeyedAsyncQueue();

// Never reset (including by the test-clear helper below): its only job is to
// guarantee no two claims, for any path, at any time, ever collide.
let nextIncarnation = 1;

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
 * THE serialized boundary for a trajectory path. Acquisition, reassignment,
 * flush/rename, and delete/retire all go through this, so none of them can
 * observe or mutate a canonical path's registry entry while another turn for
 * the same path is in flight (P1-A).
 */
export async function withTrajectoryPathLock<T>(
  canonicalPath: string,
  fn: (ctx: { currentIncarnation: number; retired: boolean }) => Promise<T> | T,
): Promise<T> {
  return await pathQueue.enqueue(canonicalPath, async () => {
    const entry = registry.get(canonicalPath);
    return await fn({
      currentIncarnation: entry?.incarnation ?? 0,
      retired: entry?.retired ?? false,
    });
  });
}

/**
 * Must only be called from inside a withTrajectoryPathLock(canonicalPath, ...) turn.
 * Claims a fresh, process-unique incarnation for canonicalPath. ownerSessionId
 * defaults to the existing entry's owner so a retire call that races ahead of
 * any writer created in this process (e.g. deleting a session whose trajectory
 * writer lived in a prior process run) still records who owned the path, which
 * is required for that owner's later resurrection to reuse the path instead of
 * hitting the collision-disambiguation branch.
 */
export function claimTrajectoryPathIncarnation(
  canonicalPath: string,
  params: { ownerSessionId?: string; retired: boolean },
): number {
  const existing = registry.get(canonicalPath);
  const incarnation = nextIncarnation;
  nextIncarnation += 1;
  registry.set(canonicalPath, {
    incarnation,
    ownerSessionId: params.ownerSessionId ?? existing?.ownerSessionId ?? "",
    retired: params.retired,
    retiredAtMs: params.retired ? Date.now() : undefined,
  });
  return incarnation;
}

/**
 * Retires canonicalPath for a disposal turn and returns a rollback that
 * restores the pre-retire entry VERBATIM. The retire must precede the runtime
 * archive rename so a flush turn queued behind this disposal observes "retired"
 * and no-ops instead of recreating the file being archived away (F1/F2/F5).
 * When that rename fails the disposal never committed: rollback re-installs the
 * exact prior entry (same incarnation and owner, not a fresh incarnation, which
 * would strand a still-live writer whose lease matches the old incarnation) so
 * the path stays fully live and a later disposal pass retries it cleanly.
 * Must only be called from inside a withTrajectoryPathLock(canonicalPath, ...) turn.
 */
export function retireTrajectoryPathForDisposal(
  canonicalPath: string,
  ownerSessionId: string,
): { rollback: () => void } {
  // Snapshot the exact prior entry object. claimTrajectoryPathIncarnation
  // replaces the map value with a fresh object rather than mutating this one,
  // so restoring it on failure is a true rollback to the pre-retire state.
  const previous = registry.get(canonicalPath);
  claimTrajectoryPathIncarnation(canonicalPath, { ownerSessionId, retired: true });
  return {
    rollback: () => {
      if (previous) {
        registry.set(canonicalPath, previous);
      } else {
        registry.delete(canonicalPath);
      }
    },
  };
}

/**
 * Resolves a candidate path to its registered filePath/incarnation, disambiguating
 * a sanitized-name collision against a different live/retired owner. Runs entirely
 * inside withTrajectoryPathLock so a claim can never interleave with a concurrent
 * delete/retire turn for the same canonical path (P1-A) — including the awaited
 * archive rename inside that turn, since the whole turn (bump + rename) shares
 * one lock admission and this claim queues behind it rather than racing it.
 *
 * onClaimed, when provided, runs INSIDE the same locked turn immediately after a
 * successful (non-collision) claim — before the lock releases. The runtime file
 * and its discovery pointer are one incarnation-owned artifact pair; publishing
 * the pointer here (rather than after acquireTrajectoryWriterLease returns) closes
 * the window where a concurrent delete could retire the path between the claim
 * and the publish, which would otherwise either leave a pointer-only orphan (the
 * publish lands after delete already ran) or let delete's own pointer removal
 * clobber a freshly published pointer for a still-live claim (round 4 P1).
 */
export async function acquireTrajectoryWriterLease(params: {
  sessionId: string;
  candidatePath: string;
  onClaimed?: (claim: { filePath: string; incarnation: number }) => void;
}): Promise<{ filePath: string; incarnation: number }> {
  let candidatePath = params.candidatePath;
  for (;;) {
    const canonicalPath = canonicalizeTrajectoryPath(candidatePath);
    const claim = await withTrajectoryPathLock(canonicalPath, () => {
      const existing = registry.get(canonicalPath);
      const claimed = (incarnation: number) => {
        params.onClaimed?.({ filePath: candidatePath, incarnation });
        return { collision: false as const, incarnation };
      };
      if (!existing) {
        return claimed(
          claimTrajectoryPathIncarnation(canonicalPath, {
            ownerSessionId: params.sessionId,
            retired: false,
          }),
        );
      }
      if (existing.ownerSessionId === params.sessionId && !existing.retired) {
        // Same live owner reconnecting (process restart, or a fresh writer
        // object requested after writers-Map eviction while the session is
        // still active) — reuse the existing incarnation unchanged.
        return claimed(existing.incarnation);
      }
      // Either a different owner already holds this canonical path (F4/F6),
      // or this owner's own path was already retired by an explicit
      // reset/delete disposal. retired is set exclusively by that disposal
      // (cleanup.ts), so a same-owner claim reaching here is never a
      // legitimate new session reusing an old id (session ids are random
      // UUIDs) — it is a late straggler write racing the disposal (e.g. an
      // async post-turn hook still finishing against the session that was
      // just reset/deleted). Disambiguating it to a fresh sibling path,
      // exactly like a cross-owner collision, keeps the tombstoned canonical
      // path permanently dead instead of letting the straggler resurrect it.
      return { collision: true as const };
    });
    if (!claim.collision) {
      return { filePath: candidatePath, incarnation: claim.incarnation };
    }
    candidatePath = disambiguateTrajectoryCandidatePath(candidatePath, params.sessionId);
  }
}

/**
 * Reassigns a still-live (non-retired) path to a new owner without a fresh
 * incarnation claim, for the resetSessionEntryLifecycle "reused transcript path"
 * case: the file and any in-flight writer for it remain valid, only the logical
 * owner changes (§3.6). Runs inside withTrajectoryPathLock for the same reason
 * acquisition does (P1-A).
 */
export async function reassignTrajectoryPathOwner(
  canonicalPath: string,
  params: { from: string; to: string },
): Promise<void> {
  await withTrajectoryPathLock(canonicalPath, () => {
    const existing = registry.get(canonicalPath);
    if (!existing || existing.retired || existing.ownerSessionId !== params.from) {
      return;
    }
    registry.set(canonicalPath, { ...existing, ownerSessionId: params.to });
  });
}

/**
 * Opportunistic/lazy reap: retired entries must survive a grace period (comfortably
 * above the cleanup-step flush timeout) so a late-arriving stale flush still finds a
 * "retired" entry rather than an absent one that would be wrongly treated as fresh.
 * Piggybacks on trimTrajectoryWriterCache's call site instead of a timer/interval.
 * Reaping only ever removes the registry *entry* — it never touches or resets
 * nextIncarnation, which is what keeps a stale writer from before the reap unable
 * to match whatever fresh incarnation a later claim on the same path receives
 * (P1-B).
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

/**
 * Reverse lookup: the canonical path currently on file for sessionId, if any.
 * This is the ONE shared derivation collision-aware callers (cleanup.ts) must
 * use to find the exact path a disambiguated owner holds, instead of
 * re-deriving the (wrong, un-suffixed) default candidate path — the previous
 * shape left a disambiguated owner's own runtime file unreachable by its own
 * delete, orphaning it right back through the collision branch it exists to
 * guard.
 */
export function findTrajectoryPathOwnedBySession(sessionId: string): string | undefined {
  for (const [canonicalPath, entry] of registry) {
    if (entry.ownerSessionId === sessionId) {
      return canonicalPath;
    }
  }
  return undefined;
}

/**
 * The same-turn ownership check collision-aware removal validates inside
 * withTrajectoryPathLock before claiming+removing: true when canonicalPath's
 * registry entry is absent (no in-process memory, e.g. the writer lived in a
 * prior process run — the pre-existing candidate-matching heuristics in
 * cleanup.ts remain the authority for that case) or is owned by sessionId.
 * False when a DIFFERENT session's owner record is on file, which must block
 * removal so no cross-session delete becomes possible.
 */
export function mayTrajectoryPathBeRemovedBySession(
  canonicalPath: string,
  sessionId: string,
): boolean {
  const entry = registry.get(canonicalPath);
  return !entry || entry.ownerSessionId === sessionId;
}

/** Test-only: does not reset nextIncarnation — see its module-level comment. */
export function clearTrajectoryWriterLifecycleRegistryForTest(): void {
  registry.clear();
}

export function getTrajectoryPathRegistryEntryForTest(
  canonicalPath: string,
): Readonly<TrajectoryPathEntry> | undefined {
  return registry.get(canonicalPath);
}
