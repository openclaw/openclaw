import path from "node:path";
import type { Root } from "@openclaw/fs-safe/root";
import { isPathInside } from "../../infra/path-guards.js";
import {
  normalizeWorkspaceSkillRoots,
  type ExecutionSkillWorkspace,
} from "../loading/workspace-skill-roots.js";
import {
  bumpSkillsSnapshotVersion,
  markSkillsSupportingFilesChanged,
  notifySkillsWatchAvailable,
  suspendSkillsSnapshotSources,
  type SkillsSourceScope,
} from "./refresh-state.js";
import { isIgnoredSkillsWatchPath } from "./refresh-watch-path.js";
import type { SkillsWatchTargetCacheEntry, WatchTarget } from "./refresh-watch-targets.js";

export type SkillsWatchChange = "skills" | "supporting";
export type SkillsPathWatchState = {
  generation: number;
  closed: boolean;
  close: () => Promise<void>;
  refreshScope: () => Promise<void>;
  authority?: Promise<Root>;
  depth: number;
  initialScan: "pending" | "ready" | "error";
  unavailable: boolean;
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

// Workspaces share each logical target. fs-safe owns its guarded directory pins
// and shares the native hub across subscriptions, including overlapping targets.
export const pathWatchers = new Map<string, SkillsPathWatchState>();
// Watch targets each workspace is currently subscribed to, used to reconcile
// subscriptions and to detect watch-target changes across calls.
export const workspaceWatchTargets = new Map<string, WatchTarget[]>();
let watchGeneration = 0;
let rootTargetPaths: Map<string, string[]> | undefined;
// A discovery change can add or retarget links; the changed roots' filesystem-derived
// target plan is stale until their owner resolves it again.
const replanningRoots = new Map<string, Set<string>>();

export function nextSkillsWatchGeneration(): number {
  return ++watchGeneration;
}

export function setWorkspaceWatchTargets(watcherKey: string, targets: WatchTarget[]): void {
  workspaceWatchTargets.set(watcherKey, targets);
  rootTargetPaths = undefined;
  replanningRoots.delete(watcherKey);
}

/** A resolved plan, changed or not, settles target discovery for this owner. */
export function settleWorkspaceWatchTargetsPlan(
  watcherKey: string,
  resolved: SkillsWatchTargetCacheEntry,
): void {
  workspaceWatchTargetCache.set(watcherKey, resolved);
  replanningRoots.delete(watcherKey);
}

export function clearWorkspaceWatchTargets(): void {
  workspaceWatchTargets.clear();
  rootTargetPaths = undefined;
  replanningRoots.clear();
}

function isVerifiedWatch(state: SkillsPathWatchState | undefined): state is SkillsPathWatchState {
  return Boolean(
    state &&
    !state.closed &&
    !state.failed &&
    state.verified &&
    !state.unavailable &&
    state.initialScan === "ready",
  );
}

/** Verified watch coverage for one configured root, keyed by its targets' generations. */
export function readSkillRootDiscoveryToken(rootDir: string): string | undefined {
  if (!rootTargetPaths) {
    const pathsByRoot = new Map<string, Set<string>>();
    for (const targets of workspaceWatchTargets.values()) {
      for (const target of targets) {
        for (const root of target.roots) {
          const paths = pathsByRoot.get(root) ?? new Set<string>();
          paths.add(target.path);
          pathsByRoot.set(root, paths);
        }
      }
    }
    rootTargetPaths = new Map(
      [...pathsByRoot].map(([root, paths]) => [root, [...paths].toSorted()]),
    );
  }
  const root = path.resolve(rootDir);
  const paths = rootTargetPaths.get(root);
  if (!paths?.length) {
    return undefined;
  }
  for (const roots of replanningRoots.values()) {
    if (roots.has(root)) {
      return undefined;
    }
  }
  const pairs: string[] = [];
  for (const targetPath of paths) {
    const state = pathWatchers.get(targetPath);
    if (!isVerifiedWatch(state)) {
      return undefined;
    }
    pairs.push(`${targetPath}:${state.depth}:${state.generation}`);
  }
  return JSON.stringify(pairs);
}

export type SkillDiscoveryDependency = { target: string; generation: number };

/** The verified watch target that observes a path within its depth and exclusions. */
export function observeSkillDiscoveryPath(filePath: string): SkillDiscoveryDependency | undefined {
  let observed: SkillDiscoveryDependency | undefined;
  for (const [targetPath, state] of pathWatchers) {
    if (!isVerifiedWatch(state) || !isPathInside(targetPath, filePath)) {
      continue;
    }
    // Watch scopes are depth-bounded and skip ignored subtrees.
    const relative = path.relative(targetPath, filePath);
    if (
      isIgnoredSkillsWatchPath(relative) ||
      relative.split(path.sep).filter(Boolean).length > state.depth
    ) {
      continue;
    }
    if (!observed || targetPath.length > observed.target.length) {
      observed = { target: targetPath, generation: state.generation };
    }
  }
  return observed;
}

export function isSkillDiscoveryDependencyCurrent(dependency: SkillDiscoveryDependency): boolean {
  const state = pathWatchers.get(dependency.target);
  return isVerifiedWatch(state) && state.generation === dependency.generation;
}
// A watcher key may include an execution root, but refresh events and versions
// retain the configured agent workspace as their stable public identity.
export type SkillsWatchOwner = {
  workspaceDir: string;
  sourceScope: SkillsSourceScope;
  sharedScanPending: boolean;
  unavailable: boolean;
  /** Bounded target discovery under this owner's current source policy. */
  reconcileTargets?: () => void;
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

export function unsubscribeWorkspaceFromPath(workspaceDir: string, watchTarget: WatchTarget): void {
  const state = pathWatchers.get(watchTarget.path);
  if (!state) {
    return;
  }
  state.subscribers.delete(workspaceDir);
  if (state.subscribers.size === 0) {
    void state.close().then(
      () => {
        if (state.subscribers.size === 0 && pathWatchers.get(watchTarget.path) === state) {
          pathWatchers.delete(watchTarget.path);
        }
      },
      () => {
        // Failed physical retirement retains this logical owner; never rearm it.
        state.failed = true;
      },
    );
  }
}

export const workspaceWatchLastEnsuredAt = new Map<string, number>();

export function disposeWorkspacePathWatchState(
  watcherKey: string,
  targets: readonly WatchTarget[],
): void {
  for (const target of targets) {
    unsubscribeWorkspaceFromPath(watcherKey, target);
  }
  workspaceWatchTargets.delete(watcherKey);
  rootTargetPaths = undefined;
  replanningRoots.delete(watcherKey);
  workspaceWatchOwners.delete(watcherKey);
  workspaceWatchTargetCache.delete(watcherKey);
  workspaceWatchLastEnsuredAt.delete(watcherKey);
  // Reacquisition invalidates after an unwatched interval. Disposal itself does
  // not change skills, including for other subscriptions sharing this workspace.
}

// Session turns re-ensure their workspace; entries older than this are treated
// as abandoned subscriptions and evicted by the next ensure call.
const SKILLS_WORKSPACE_WATCH_IDLE_TTL_MS = 60 * 60_000;
const MAX_SKILLS_WORKSPACE_WATCH_STATES = 128;

export function evictWorkspaceWatchStates(
  now: number,
  dispose: (watcherKey: string) => void,
): void {
  const evict = (watcherKey: string) => {
    const owner = workspaceWatchOwners.get(watcherKey);
    dispose(watcherKey);
    if (!owner) {
      return;
    }
    const remainingOwners = Array.from(workspaceWatchOwners.values()).filter(
      (other) => other.workspaceDir === owner.workspaceDir,
    );
    if (remainingOwners.length === 0) {
      suspendSkillsSnapshotSources(owner.workspaceDir, {});
    }
    if (
      owner.sourceScope.executionWorkspaceDir &&
      !remainingOwners.some(
        (other) =>
          other.sourceScope.executionWorkspaceDir === owner.sourceScope.executionWorkspaceDir &&
          other.sourceScope.executionWorkspaceFileHost ===
            owner.sourceScope.executionWorkspaceFileHost,
      )
    ) {
      suspendSkillsSnapshotSources(owner.workspaceDir, owner.sourceScope);
    }
  };
  const cutoff = now - SKILLS_WORKSPACE_WATCH_IDLE_TTL_MS;
  for (const [watcherKey, lastEnsuredAt] of workspaceWatchLastEnsuredAt) {
    if (lastEnsuredAt < cutoff) {
      evict(watcherKey);
    }
  }
  for (const watcherKey of workspaceWatchLastEnsuredAt.keys()) {
    if (workspaceWatchLastEnsuredAt.size <= MAX_SKILLS_WORKSPACE_WATCH_STATES) {
      break;
    }
    evict(watcherKey);
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
      if (change === "skills") {
        const roots = replanningRoots.get(watcherKey) ?? new Set<string>();
        for (const root of targets.find((target) => target.path === targetPath)?.roots ?? []) {
          roots.add(root);
        }
        replanningRoots.set(watcherKey, roots);
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
            (scope) =>
              scope.executionWorkspaceDir === owner.sourceScope.executionWorkspaceDir &&
              scope.executionWorkspaceFileHost === owner.sourceScope.executionWorkspaceFileHost,
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
  drainSkillsWatchReplans();
}

let drainingReplans = false;
// Every publisher (debounced flush, readiness recovery) re-plans changed roots now,
// so new or retargeted links gain watchers before discovery is reused.
function drainSkillsWatchReplans(): void {
  if (drainingReplans) {
    return;
  }
  drainingReplans = true;
  try {
    for (const watcherKey of replanningRoots.keys()) {
      workspaceWatchOwners.get(watcherKey)?.reconcileTargets?.();
    }
  } finally {
    drainingReplans = false;
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

/** Discovery host is part of watcher identity, including identical path strings. */
export function resolveSkillsWatchScope(
  params: ExecutionSkillWorkspace & { workspaceDir: string; agentId?: string },
) {
  const workspaceDir = params.workspaceDir.trim();
  const { executionWorkspaceDir, executionWorkspaceFileHost } = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: params.executionWorkspaceDir,
    executionWorkspaceFileHost: params.executionWorkspaceFileHost,
  });
  return {
    workspaceDir,
    executionWorkspaceDir,
    watcherKey: JSON.stringify([
      workspaceDir,
      executionWorkspaceDir,
      params.agentId,
      executionWorkspaceFileHost,
    ]),
    sourceScope: { executionWorkspaceDir, executionWorkspaceFileHost },
  };
}
