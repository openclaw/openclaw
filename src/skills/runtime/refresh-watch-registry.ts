import type { Result } from "@openclaw/normalization-core/result";
import { isPathInside } from "../../infra/path-guards.js";
import {
  bumpSkillsSnapshotVersion,
  markSkillsSupportingFilesChanged,
  notifySkillsWatchAvailable,
  type SkillsSourceScope,
} from "./refresh-state.js";
import type { SkillsWatchTargetCacheEntry, WatchTarget } from "./refresh-watch-targets.js";

export type SkillsWatchChange = "skills" | "supporting";
export type SkillsPathWatchState = {
  closed: boolean;
  close: () => Promise<Result<void, unknown>>;
  watchRoot: string;
  ancestorRoot: string;
  depth: number;
  initialScan: "pending" | "ready" | "error";
  unavailable: boolean;
  pooledNative: boolean;
  verified: boolean;
  failed: boolean;
  recovering: boolean;
  replacing: boolean;
  timer?: ReturnType<typeof setTimeout>;
  pendingAt?: number;
  pendingPath?: string;
  pendingChange?: SkillsWatchChange;
  readonly subscribers: Set<string>;
};

// One watcher per unique watched directory. Agent workspaces that include the
// same shared skill root (the global skills dir, the home skills dir, or a
// configured extra/plugin dir) subscribe to the same watcher instead of each
// opening its own, so open file descriptors scale with distinct directories
// rather than with agent count.
export const pathWatchers = new Map<string, SkillsPathWatchState>();
// Watch targets each workspace is currently subscribed to, used to reconcile
// subscriptions and to detect watch-target changes across calls.
export const workspaceWatchTargets = new Map<string, WatchTarget[]>();
// A watcher key may include an execution root, but refresh events and versions
// retain the configured agent workspace as their stable public identity.
export type SkillsWatchOwner = {
  workspaceDir: string;
  sourceScope: SkillsSourceScope;
  sharedScanPending: boolean;
  unavailable: boolean;
};
export const workspaceWatchOwners = new Map<string, SkillsWatchOwner>();
// Resolved nested skill watch roots are filesystem-derived. Cache them so the
// per-turn watcher reconciliation path stays cheap until config or watched
// filesystem changes require a fresh root scan.
export const workspaceWatchTargetCache = new Map<string, SkillsWatchTargetCacheEntry>();
export type PendingSkillsWatchChange = {
  targetPath: string;
  state: SkillsPathWatchState;
  watcherKeys: Iterable<string>;
  changedPath?: string;
  change: SkillsWatchChange | "initial-scan" | "unavailable";
};

// A peer can keep Chokidar's old inode handles alive after our successful close.
// Keep this observation loss across subscription disposal and ordinary shutdown.
export const uncertainPooledObservationRoots = new Set<string>();
export const hasUncertainPooledCoverage = (root: string) =>
  Array.from(uncertainPooledObservationRoots).some(
    (lost) => isPathInside(root, lost) || isPathInside(lost, root),
  );

export function recordPooledObservationLoss(root: string): void {
  uncertainPooledObservationRoots.add(root);
  const changes: PendingSkillsWatchChange[] = [];
  for (const [targetPath, state] of pathWatchers) {
    if (state.closed || !state.pooledNative || !hasUncertainPooledCoverage(targetPath)) {
      continue;
    }
    state.verified = false;
    if (!state.unavailable) {
      state.unavailable = true;
      changes.push({ targetPath, state, watcherKeys: state.subscribers, change: "unavailable" });
    }
  }
  publishSkillsWatchChanges(changes);
}

export function unsubscribeWorkspaceFromPath(workspaceDir: string, watchTarget: WatchTarget): void {
  const state = pathWatchers.get(watchTarget.path);
  if (!state) {
    return;
  }
  state.subscribers.delete(workspaceDir);
  if (state.subscribers.size === 0) {
    void state.close().then((result) => {
      if (
        result.ok &&
        state.subscribers.size === 0 &&
        pathWatchers.get(watchTarget.path) === state
      ) {
        pathWatchers.delete(watchTarget.path);
      }
    });
  }
}

export const hasUnreadySharedTargets = (watcherKey: string) =>
  (workspaceWatchTargets.get(watcherKey) ?? []).some(
    (target) => !target.executionOnly && pathWatchers.get(target.path)?.initialScan !== "ready",
  );

export function hasVerifiedCoverage(watcherKey: string): boolean {
  return (
    workspaceWatchTargets.get(watcherKey)?.every((target) => {
      const state = pathWatchers.get(target.path);
      return state && !state.closed && state.verified && !state.unavailable;
    }) ?? false
  );
}

export function publishRecoveredCoverage(): void {
  for (const [watcherKey, owner] of workspaceWatchOwners) {
    if (owner.unavailable && hasVerifiedCoverage(watcherKey)) {
      owner.unavailable = false;
      notifySkillsWatchAvailable({
        workspaceDir: owner.workspaceDir,
        sourceScope: owner.sourceScope,
      });
    }
  }
}

export function publishSkillsWatchChanges(changes: PendingSkillsWatchChange[]): void {
  const affected = new Map<
    string,
    Array<{
      pending: PendingSkillsWatchChange;
      watcherKey: string;
      targets: WatchTarget[];
    }>
  >();
  for (const pending of changes) {
    for (const watcherKey of pending.watcherKeys) {
      const owner = workspaceWatchOwners.get(watcherKey);
      const targets = workspaceWatchTargets.get(watcherKey);
      if (owner && targets) {
        const entries = affected.get(owner.workspaceDir) ?? [];
        entries.push({ pending, watcherKey, targets });
        affected.set(owner.workspaceDir, entries);
      }
    }
  }
  for (const [workspaceDir, entries] of affected) {
    const scopes = new Map<SkillsWatchChange, SkillsSourceScope[] | undefined>();
    let changedPath: string | undefined;
    let unavailable = false;
    for (const { pending, watcherKey, targets } of entries) {
      const owner = workspaceWatchOwners.get(watcherKey);
      const { targetPath, state, change } = pending;
      // An earlier workspace's listener can retire or replace a later subscription.
      if (
        !owner ||
        state.closed ||
        pathWatchers.get(targetPath) !== state ||
        !state.subscribers.has(watcherKey) ||
        workspaceWatchTargets.get(watcherKey) !== targets
      ) {
        continue;
      }
      if (change !== "supporting") {
        workspaceWatchTargetCache.delete(watcherKey);
        changedPath = pending.changedPath;
      }
      unavailable ||= change === "unavailable";
      owner.unavailable ||= change === "unavailable";
      const initialScan = change === "initial-scan";
      const shared = initialScan
        ? owner.sharedScanPending
        : targets.find((entry) => entry.path === targetPath)?.executionOnly !== true;
      if (initialScan && shared) {
        // This publication covers settled shared roots for every existing owner,
        // even when one owner's execution-only scan still delays its own readiness.
        for (const [key, other] of workspaceWatchOwners) {
          other.sharedScanPending &&=
            other.workspaceDir !== workspaceDir || hasUnreadySharedTargets(key);
        }
      }
      const kind = change === "supporting" ? "supporting" : "skills";
      if (shared) {
        scopes.set(kind, undefined);
      } else if (!scopes.has(kind) || scopes.get(kind)) {
        const selected = scopes.get(kind) ?? [];
        if (
          !selected.some(
            (scope) => scope.executionWorkspaceDir === owner.sourceScope.executionWorkspaceDir,
          )
        ) {
          selected.push(owner.sourceScope);
        }
        scopes.set(kind, selected);
      }
    }
    // Supporting changes can cover scopes outside the discovery change in this batch.
    if (scopes.has("supporting")) {
      markSkillsSupportingFilesChanged({ workspaceDir, sourceScopes: scopes.get("supporting") });
    }
    if (scopes.has("skills")) {
      bumpSkillsSnapshotVersion({
        workspaceDir,
        sourceScopes: scopes.get("skills"),
        reason: unavailable ? "watch-unavailable" : "watch",
        changedPath,
      });
    }
  }
}

export function flushSkillsWatchChanges(trigger: SkillsPathWatchState): void {
  if (trigger.closed) {
    return;
  }
  const now = performance.now();
  const changes: PendingSkillsWatchChange[] = [];
  for (const [targetPath, state] of pathWatchers) {
    if (
      state.closed ||
      state.timer === undefined ||
      (state !== trigger && (state.pendingAt === undefined || state.pendingAt > now))
    ) {
      continue;
    }
    changes.push({
      targetPath,
      state,
      watcherKeys: state.subscribers,
      changedPath: state.pendingPath,
      change: state.pendingChange ?? "skills",
    });
    clearTimeout(state.timer);
    state.timer = undefined;
    state.pendingAt = undefined;
    state.pendingPath = undefined;
    state.pendingChange = undefined;
  }
  // Keep each target's debounce deadline; a busy target cannot delay another workspace.
  publishSkillsWatchChanges(changes);
}
