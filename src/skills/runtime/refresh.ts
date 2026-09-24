import { AsyncLocalStorage } from "node:async_hooks";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getFileWatchCapacityCode } from "../../infra/fs-watch-errors.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { normalizeWorkspaceSkillRoots } from "../loading/workspace-skill-roots.js";
import {
  resolveWorkspaceSkillSourcePlan,
  splitSkillSourcePlan,
  type WorkspaceSkillSourcePlan,
} from "../loading/workspace-skill-sources.js";
import { acquireSkillsAncestorWatcher } from "./refresh-ancestor-watch.js";
import { createSkillsContentWatcher } from "./refresh-content-watch.js";
import { createRawSkillFileScheduler } from "./refresh-file-stability.js";
import {
  closeRemoteSkillsWatchers,
  disposeRemoteSkillsWatcher,
  ensureRemoteSkillsWatcher,
} from "./refresh-remote.js";
import {
  bumpSkillsSnapshotVersion,
  markSkillsSupportingFilesChanged,
  resetSkillsRefreshStateForTest,
  setSkillsChangeListenerErrorHandler,
  suspendSkillsSnapshotSources,
  type SkillsSourceScope,
} from "./refresh-state.js";
import { joinSkillsWatcherCloses } from "./refresh-watch-close.js";
import {
  createSkillsWatchPathFilter,
  getRawWatchedPath,
  isSkillDiscoveryFileWatchPath,
  rawPathToString,
  resolveRawSkillsWatchPath,
  makeSkillsWatchTarget,
  resolveSkillsWatchAncestors,
  resolveSkillsWatcherUsePolling,
} from "./refresh-watch-path.js";
import {
  compareSkillsWatchTargets,
  resolveSkillsWatchTargets,
  type SkillsWatchTargetCacheEntry,
  type WatchTarget,
} from "./refresh-watch-targets.js";
import { createSkillsContentWatchFactory } from "./refresh-watch-transport.js";
export { registerSkillsChangeListener } from "./refresh-state.js";

type SkillsWatchChange = "skills" | "supporting";
type SkillsPathWatchState = {
  closed: boolean;
  close: () => void;
  schedule: (path?: string) => void;
  watchRoot: string;
  ancestorRoot: string;
  depth: number;
  initialScan: "pending" | "ready" | "error";
  unavailable: boolean;
  timer?: ReturnType<typeof setTimeout>;
  pendingAt?: number;
  pendingPath?: string;
  pendingChange?: SkillsWatchChange;
  readonly subscribers: Set<string>;
};

const log = createSubsystemLogger("gateway/skills");
// Gateway startup imports this owner before serving turns. Shared watcher handles,
// including later rebuilds, must inherit that lifetime rather than the triggering turn.
const watchContent = createSkillsContentWatchFactory(AsyncLocalStorage.snapshot());
const SKILLS_WATCH_DEBOUNCE_MS = 250;
// One watcher per unique watched directory. Agent workspaces that include the
// same shared skill root (the global skills dir, the home skills dir, or a
// configured extra/plugin dir) subscribe to the same watcher instead of each
// opening its own, so open file descriptors scale with distinct directories
// rather than with agent count.
const pathWatchers = new Map<string, SkillsPathWatchState>();
// Ancestor loss can strand shared native handles on old inodes. Logical ready
// or reacquisition cannot certify them; retain scoped outage facts until restart.
const failedAncestorRoots = new Set<string>();
let nativeWatchCapacityFailed = false;
// Watch targets each workspace is currently subscribed to, used to reconcile
// subscriptions and to detect watch-target changes across calls.
const workspaceWatchTargets = new Map<string, WatchTarget[]>();
// A watcher key may include an execution root, but refresh events and versions
// retain the configured agent workspace as their stable public identity.
const workspaceWatchOwners = new Map<
  string,
  { workspaceDir: string; sourceScope: SkillsSourceScope; sharedScanPending: boolean }
>();
// Resolved nested skill watch roots are filesystem-derived. Cache them so the
// per-turn watcher reconciliation path stays cheap until config or watched
// filesystem changes require a fresh root scan.
const workspaceWatchTargetCache = new Map<string, SkillsWatchTargetCacheEntry>();
const workspaceWatchLastEnsuredAt = new Map<string, number>();
// Session turns re-ensure their workspace; entries older than this are treated
// as abandoned subscriptions and evicted by the next ensure call.
const SKILLS_WORKSPACE_WATCH_IDLE_TTL_MS = 60 * 60_000;
const MAX_SKILLS_WORKSPACE_WATCH_STATES = 128;

setSkillsChangeListenerErrorHandler((err) => {
  log.warn(`skills change listener failed: ${String(err)}`);
});

type PendingSkillsWatchChange = {
  targetPath: string;
  state: SkillsPathWatchState;
  watcherKeys: Iterable<string>;
  changedPath?: string;
  change: SkillsWatchChange | "initial-scan" | "unavailable";
};

const hasUnreadySharedTargets = (watcherKey: string) =>
  (workspaceWatchTargets.get(watcherKey) ?? []).some(
    (target) => !target.executionOnly && pathWatchers.get(target.path)?.initialScan !== "ready",
  );

function publishSkillsWatchChanges(changes: PendingSkillsWatchChange[]): void {
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

function flushSkillsWatchChanges(trigger: SkillsPathWatchState): void {
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

function createSkillsPathWatcher(
  target: WatchTarget,
  previousAncestorRoot = target.watchRoot,
): SkillsPathWatchState {
  const usePolling = resolveSkillsWatcherUsePolling();
  const pathFilter = createSkillsWatchPathFilter(target.path, usePolling);
  const { ancestorRoot, ancestorRoots } = resolveSkillsWatchAncestors(target, previousAncestorRoot);
  const pendingAncestors = new Set(ancestorRoots);
  let contentReady = target.path !== target.watchRoot;
  let content: ReturnType<typeof createSkillsContentWatcher> | undefined;
  const releaseAncestors: (() => void)[] = [];
  const state: SkillsPathWatchState = {
    closed: false,
    close: () => {
      if (state.closed) {
        return;
      }
      state.closed = true;
      clearTimeout(state.timer);
      void content?.close();
      for (const release of releaseAncestors) {
        release();
      }
    },
    schedule: (changedPath) => schedule(changedPath),
    watchRoot: target.watchRoot,
    ancestorRoot,
    depth: target.depth,
    initialScan: "pending",
    unavailable: Array.from(failedAncestorRoots).some((root) => isPathInside(root, target.path)),
    subscribers: new Set<string>(),
  };
  const targetChange = { targetPath: target.path, state, watcherKeys: state.subscribers };
  const isCurrent = () => !state.closed && pathWatchers.get(target.path) === state;
  const reconcileRoot = (changedPath?: string, replaceContent = false) => {
    if (!isCurrent()) {
      return true;
    }
    const nextTarget = makeSkillsWatchTarget(target.path, state.depth, state.ancestorRoot);
    if (nextTarget.watchRoot === state.watchRoot && !replaceContent) {
      return false;
    }
    for (const subscriber of state.subscribers) {
      workspaceWatchTargetCache.delete(subscriber);
      for (const entry of workspaceWatchTargets.get(subscriber) ?? []) {
        if (entry.path === target.path) {
          entry.watchRoot = nextTarget.watchRoot;
        }
      }
    }
    const subscriber = state.subscribers.values().next().value;
    if (subscriber !== undefined) {
      subscribeWorkspaceToPath(subscriber, nextTarget, replaceContent);
      if (changedPath) {
        pathWatchers.get(target.path)?.schedule(changedPath);
      }
    }
    return true;
  };

  const schedule = (changedPath?: string, change: SkillsWatchChange = "skills") => {
    // File-stability work may finish after this subscription has been closed.
    if (!isCurrent() || (change === "supporting" && state.pendingChange === "skills")) {
      return;
    }
    state.pendingPath = changedPath ?? state.pendingPath;
    state.pendingChange = change;
    clearTimeout(state.timer);
    state.pendingAt = performance.now() + SKILLS_WATCH_DEBOUNCE_MS;
    state.timer = setTimeout(() => flushSkillsWatchChanges(state), SKILLS_WATCH_DEBOUNCE_MS);
  };
  const scheduleRawSkillFile = createRawSkillFileScheduler({
    watcher: state,
    stabilityMs: SKILLS_WATCH_DEBOUNCE_MS,
    schedule,
    onError: (changedPath, err) => {
      log.warn(`skills watcher stability check failed (${changedPath}): ${String(err)}`);
    },
  });

  // ignoreInitial suppresses writes discovered before native watches are ready.
  // Reconcile the whole workspace once its initial scans finish, rather than
  // rebuilding metadata for every root that becomes ready.
  const ready = (rescan = false) => {
    if (reconcileRoot() || !contentReady) {
      return;
    }
    // Verified content can restore a read failure, but not native coverage lost
    // during an ancestor outage, even after a same-path observer becomes ready.
    const ancestorsSettled = pendingAncestors.size === 0;
    if (ancestorsSettled) {
      state.unavailable = Array.from(failedAncestorRoots).some((root) =>
        isPathInside(root, target.path),
      );
    }
    const changes: PendingSkillsWatchChange[] = [];
    if (ancestorsSettled && state.initialScan !== "ready") {
      state.initialScan = "ready";
      const watcherKeys = Array.from(state.subscribers).filter((watcherKey) =>
        workspaceWatchTargets.get(watcherKey)?.every((entry) => {
          const current = pathWatchers.get(entry.path);
          return current && !current.closed && current.initialScan !== "pending";
        }),
      );
      changes.push({ ...targetChange, watcherKeys, change: "initial-scan" });
    }
    if (rescan) {
      changes.push({ ...targetChange, change: "skills" });
    }
    publishSkillsWatchChanges(changes);
  };
  const onChange = (event: string, changedPath: string) => {
    const ancestorChanged = event === "ancestor";
    if (
      !isCurrent() ||
      ((!content || ancestorChanged || event === "addDir" || event === "unlinkDir") &&
        // A coalesced native rename can replace an ancestor and recreate this
        // same path before delivery, leaving the content watch on the old inode.
        reconcileRoot(changedPath, ancestorChanged && Boolean(content)))
    ) {
      return;
    }
    const skillsRelevant = ancestorChanged || pathFilter.isRelevant(event, changedPath);
    if (skillsRelevant && (event === "addDir" || event === "unlinkDir")) {
      content?.structureChanged();
      if (event === "addDir") {
        content?.rescan();
      }
    }
    if (skillsRelevant || pathFilter.isSupportingPath(changedPath)) {
      schedule(changedPath, skillsRelevant ? "skills" : "supporting");
    }
  };
  const handleRaw = (_eventName: string, rawPath: unknown, details: unknown) => {
    if (!isCurrent()) {
      return;
    }
    const rawPathText = rawPathToString(rawPath);
    const changedPath = rawPathText
      ? resolveRawSkillsWatchPath(rawPathText, details)
      : getRawWatchedPath(details);
    if (!changedPath) {
      return;
    }
    // Coalesced ancestor replacement can retain the same directory entry and
    // suppress Chokidar's addDir event, including a symlink replaced by a directory.
    if (isPathInside(changedPath, target.path) && reconcileRoot(changedPath)) {
      return;
    }
    if (!rawPathText) {
      if (isPathInside(target.path, changedPath)) {
        // Native filename loss can conceal a skill edit; content reconciliation decides.
        schedule(changedPath);
      }
      return;
    }
    if (isSkillDiscoveryFileWatchPath(changedPath) && isPathInside(target.path, changedPath)) {
      if (usePolling) {
        return;
      }
      scheduleRawSkillFile(changedPath);
    } else if (pathFilter.isSupportingPath(changedPath)) {
      schedule(changedPath, "supporting");
    }
  };
  const onRaw = (...args: Parameters<typeof handleRaw>) => {
    if (usePolling) {
      // Chokidar's watchFile callback reads its listeners after emitting raw.
      // Reconciliation can retire its last subscription, so finish delivery first.
      queueMicrotask(() => handleRaw(...args));
    } else {
      handleRaw(...args);
    }
  };
  const onError = (err: unknown, rescan = false, ancestor?: string) => {
    if (!isCurrent()) {
      return;
    }
    if (ancestor) {
      failedAncestorRoots.add(ancestor);
    }
    const capacityCode = usePolling ? undefined : getFileWatchCapacityCode(err);
    if (capacityCode) {
      if (!nativeWatchCapacityFailed) {
        nativeWatchCapacityFailed = true;
        log.warn(
          `skills native watcher capacity exhausted (${capacityCode}); refreshing skills during agent preparation`,
        );
        for (const active of pathWatchers.values()) {
          active.close();
        }
        for (const workspaceDir of new Set(
          Array.from(workspaceWatchOwners.values(), (owner) => owner.workspaceDir),
        )) {
          bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch-unavailable" });
        }
      }
      return;
    }
    log.warn(`skills watcher error (${target.path}): ${String(err)}`);
    // Startup settlement and observation availability are separate facts: a
    // later failure must not relatch shared startup fan-in or hide its own gap.
    if (state.initialScan === "pending") {
      state.initialScan = "error";
    }
    const changes: PendingSkillsWatchChange[] = [];
    for (const [targetPath, current] of pathWatchers) {
      const affected = ancestor ? isPathInside(ancestor, targetPath) : current === state;
      if (!affected || current.closed || current.unavailable) {
        continue;
      }
      current.unavailable = true;
      const watcherKeys = current.subscribers;
      changes.push({ targetPath, state: current, watcherKeys, change: "unavailable" });
    }
    publishSkillsWatchChanges(changes);
    if (rescan) {
      schedule();
    }
  };
  if (target.path === target.watchRoot) {
    content = createSkillsContentWatcher({
      watch: () => watchContent(target, usePolling, pathFilter.ignored, SKILLS_WATCH_DEBOUNCE_MS),
      isCurrent,
      isStructuralRaw: pathFilter.isStructuralRaw,
      ready: (rescan) => {
        contentReady = true;
        ready(rescan);
      },
      changed: onChange,
      raw: onRaw,
      error: (error, rescan) => {
        contentReady = false;
        onError(error, rescan);
      },
    });
  }
  for (const root of ancestorRoots) {
    releaseAncestors.push(
      acquireSkillsAncestorWatcher(root, usePolling, {
        path: target.path,
        ignored: pathFilter.ignored,
        ready: () => {
          pendingAncestors.delete(root);
          ready();
        },
        changed: onChange,
        reconcile: () => {
          if (!isCurrent() || reconcileRoot(target.path)) {
            return;
          }
          content?.structureChanged();
          content?.rescan();
          schedule(target.path);
        },
        raw: onRaw,
        error: (error) => {
          pendingAncestors.delete(root);
          onError(error, false, root);
          // Missing roots still need the ancestor's recovery scan.
          if (content) {
            ready();
          }
        },
      }).release,
    );
  }

  return state;
}

function subscribeWorkspaceToPath(
  workspaceDir: string,
  watchTarget: WatchTarget,
  replaceContent = false,
): void {
  const existing = pathWatchers.get(watchTarget.path);
  if (
    existing &&
    !replaceContent &&
    existing.watchRoot === watchTarget.watchRoot &&
    existing.depth >= watchTarget.depth
  ) {
    existing.subscribers.add(workspaceDir);
    return;
  }
  if (existing) {
    // A changed ancestor or deeper target needs a rebuilt watcher, preserving subscribers.
    existing.close();
    const next = createSkillsPathWatcher(
      {
        ...watchTarget,
        depth: Math.max(existing.depth, watchTarget.depth),
      },
      existing.ancestorRoot,
    );
    for (const subscriber of existing.subscribers) {
      next.subscribers.add(subscriber);
      const owner = workspaceWatchOwners.get(subscriber);
      if (
        owner &&
        workspaceWatchTargets
          .get(subscriber)
          ?.some((target) => target.path === watchTarget.path && !target.executionOnly)
      ) {
        owner.sharedScanPending = true;
      }
    }
    next.subscribers.add(workspaceDir);
    pathWatchers.set(watchTarget.path, next);
    return;
  }
  const state = createSkillsPathWatcher(watchTarget);
  state.subscribers.add(workspaceDir);
  pathWatchers.set(watchTarget.path, state);
}

function unsubscribeWorkspaceFromPath(workspaceDir: string, watchTarget: WatchTarget): void {
  const state = pathWatchers.get(watchTarget.path);
  if (!state) {
    return;
  }
  state.subscribers.delete(workspaceDir);
  if (state.subscribers.size === 0) {
    state.close();
    pathWatchers.delete(watchTarget.path);
  }
}

function disposeWorkspaceWatchState(
  watcherKey: string,
  watchTargets: readonly WatchTarget[] = workspaceWatchTargets.get(watcherKey) ?? [],
): void {
  disposeRemoteSkillsWatcher(watcherKey);
  for (const watchTarget of watchTargets) {
    unsubscribeWorkspaceFromPath(watcherKey, watchTarget);
  }
  workspaceWatchTargets.delete(watcherKey);
  workspaceWatchOwners.delete(watcherKey);
  workspaceWatchTargetCache.delete(watcherKey);
  workspaceWatchLastEnsuredAt.delete(watcherKey);
  // Reacquisition invalidates after an unwatched interval. Disposal itself does
  // not change skills, including for other subscriptions sharing this workspace.
}

function evictWorkspaceWatchStates(now: number): void {
  const evict = (watcherKey: string) => {
    const owner = workspaceWatchOwners.get(watcherKey);
    disposeWorkspaceWatchState(watcherKey);
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
          other.sourceScope.executionWorkspaceDir === owner.sourceScope.executionWorkspaceDir,
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

export function ensureSkillsWatcher(params: {
  workspaceDir: string;
  executionWorkspaceDir?: string;
  config?: OpenClawConfig;
  agentId?: string;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  /** Already admitted roots, mapped into the workspace host filesystem. */
  sourcePlan?: WorkspaceSkillSourcePlan;
}) {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    return;
  }
  const { executionWorkspaceDir } = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: params.executionWorkspaceDir,
  });
  const watcherKey = JSON.stringify([workspaceDir, executionWorkspaceDir, params.agentId]);
  const sourceScope = { executionWorkspaceDir };
  const owner = {
    workspaceDir,
    sourceScope,
    sharedScanPending: workspaceWatchOwners.get(watcherKey)?.sharedScanPending ?? false,
  };
  workspaceWatchOwners.set(watcherKey, owner);
  const refreshInputs = {
    sourceScope,
    config: params.config,
    pluginMetadataSnapshot: params.pluginMetadataSnapshot,
  };
  const now = Date.now();
  const watchEnabled = params.config?.skills?.load?.watch !== false;
  const previousTargets = workspaceWatchTargets.get(watcherKey) ?? [];

  if (!watchEnabled) {
    disposeWorkspaceWatchState(watcherKey, previousTargets);
    evictWorkspaceWatchStates(now);
    return;
  }

  // Map order breaks equal-clock ties and promotes reuse without adding a generation.
  workspaceWatchLastEnsuredAt.delete(watcherKey);
  workspaceWatchLastEnsuredAt.set(watcherKey, now);
  evictWorkspaceWatchStates(now);
  const access = getAgentWorkspaceAccess(workspaceDir, "loadSkills");
  let localPlan = params.sourcePlan;
  if (access?.loadSkills) {
    const { gatewayPlan, workspacePlan } = splitSkillSourcePlan(
      resolveWorkspaceSkillSourcePlan(workspaceDir, params),
    );
    ensureRemoteSkillsWatcher({
      watcherKey,
      workspaceDir,
      executionWorkspaceDir,
      access,
      sourcePlan: workspacePlan,
    });
    localPlan = gatewayPlan;
  } else {
    disposeRemoteSkillsWatcher(watcherKey);
  }
  if (nativeWatchCapacityFailed) {
    // Reconcile file-backed sources during preparation while native observation
    // is unavailable, without reopening watches.
    workspaceWatchTargetCache.delete(watcherKey);
    bumpSkillsSnapshotVersion({ workspaceDir, refreshInputs, reason: "watch" });
    return;
  }
  const failedTargets = previousTargets.filter(
    (entry) => pathWatchers.get(entry.path)?.unavailable,
  );
  if (failedTargets.length > 0) {
    // A failed verifier leaves observation incomplete. Preparation must rescan
    // filesystem-derived targets before reconciling only the affected sources.
    workspaceWatchTargetCache.delete(watcherKey);
  }
  const cachedTargets = workspaceWatchTargetCache.get(watcherKey);
  const resolvedTargets = resolveSkillsWatchTargets(
    workspaceDir,
    params.config,
    params.agentId,
    access?.loadSkills ? undefined : executionWorkspaceDir,
    params.pluginMetadataSnapshot,
    localPlan,
    cachedTargets,
  );
  if (resolvedTargets !== cachedTargets) {
    workspaceWatchTargetCache.set(watcherKey, resolvedTargets);
  }
  const watchTargets = resolvedTargets.targets;
  const coveredTargets = previousTargets.length
    ? previousTargets
    : Array.from(workspaceWatchOwners).flatMap(([key, other]) =>
        other.workspaceDir === workspaceDir ? (workspaceWatchTargets.get(key) ?? []) : [],
      );
  const targetChanges = compareSkillsWatchTargets(previousTargets, watchTargets, coveredTargets);
  const watcherDepthsCoverTargets = watchTargets.every(
    (watchTarget) => (pathWatchers.get(watchTarget.path)?.depth ?? -1) >= watchTarget.depth,
  );
  if (targetChanges.targetsUnchanged && watcherDepthsCoverTargets && failedTargets.length === 0) {
    return;
  }
  const nextTargetKeys = new Set(watchTargets.map((target) => target.path));
  for (const watchTarget of previousTargets) {
    if (!nextTargetKeys.has(watchTarget.path)) {
      unsubscribeWorkspaceFromPath(watcherKey, watchTarget);
    }
  }
  for (const watchTarget of watchTargets) {
    subscribeWorkspaceToPath(watcherKey, watchTarget);
  }
  workspaceWatchTargets.set(watcherKey, watchTargets);
  owner.sharedScanPending ||= hasUnreadySharedTargets(watcherKey);
  const joinedUnavailable = watchTargets.some(
    (target) =>
      pathWatchers.get(target.path)?.unavailable &&
      !previousTargets.some((previous) => previous.path === target.path),
  );

  // Acquisition must invalidate reads cached during an unwatched interval,
  // before the first consumer runs or the asynchronous initial scan completes.
  if (!targetChanges.targetsUnchanged || failedTargets.length > 0) {
    bumpSkillsSnapshotVersion({
      workspaceDir,
      sourceScopes:
        targetChanges.sharedTargetsChanged || failedTargets.some((target) => !target.executionOnly)
          ? undefined
          : [sourceScope],
      refreshInputs,
      // New subscribers need the existing availability fact once. Repeated
      // preparation reconciles content without requeueing a watch-only worker.
      reason: joinedUnavailable ? "watch-unavailable" : "watch-targets",
      changedPath: watchTargets.map((target) => target.path).join("|"),
    });
  }
}

export async function closeSkillsWatchers(resetState = false): Promise<void> {
  if (resetState) {
    resetSkillsRefreshStateForTest();
  }
  const active = Array.from(pathWatchers.values());
  nativeWatchCapacityFailed = false;
  pathWatchers.clear();
  workspaceWatchTargets.clear();
  workspaceWatchOwners.clear();
  workspaceWatchTargetCache.clear();
  workspaceWatchLastEnsuredAt.clear();
  for (const state of active) {
    state.close();
  }
  await Promise.all([joinSkillsWatcherCloses(), closeRemoteSkillsWatchers()]);
  if (resetState) {
    failedAncestorRoots.clear();
  }
}
