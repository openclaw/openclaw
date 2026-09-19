import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import chokidar from "chokidar";
import { isDefaultStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getFileWatchCapacityCode } from "../../infra/fs-watch-errors.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import {
  resolvePluginSkillRoots,
  resolvePluginSkillRootsFromMetadata,
} from "../loading/plugin-skills.js";
import { resolveAllowedSkillSymlinkTargetRealPaths } from "../loading/symlink-targets.js";
import {
  normalizeWorkspaceSkillRoots,
  resolveWorkspaceSkillDirectories,
} from "../loading/workspace-skill-roots.js";
import { resolveWorkshopWatchRoots } from "../workshop/skills-root.js";
import { areOrderedArraysEqual } from "./ordered-array-equality.js";
import { acquireSkillsAncestorWatcher } from "./refresh-ancestor-watch.js";
import { createRawSkillFileScheduler } from "./refresh-file-stability.js";
import {
  bumpSkillsSnapshotVersion,
  markSkillsSupportingFilesChanged,
  resetSkillsRefreshStateForTest,
  setSkillsChangeListenerErrorHandler,
  suspendSkillsSnapshotSources,
  type SkillsSourceScope,
} from "./refresh-state.js";
import { joinSkillsWatcherCloses, teardownSkillsPathWatcher } from "./refresh-watch-close.js";
import {
  createSkillsWatchPathFilter,
  getRawWatchedPath,
  isSkillDiscoveryFileWatchPath,
  rawPathToString,
  resolveRawSkillsWatchPath,
  makeSkillsWatchTarget,
  resolveSkillsWatcherUsePolling,
  toWatchRoot,
} from "./refresh-watch-path.js";
import {
  addSkillSourceWatchTargets,
  GROUPED_SKILLS_WATCH_DEPTH,
  type WatchTarget,
} from "./refresh-watch-targets.js";
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
  timer?: ReturnType<typeof setTimeout>;
  pendingPath?: string;
  pendingChange?: SkillsWatchChange;
  readonly subscribers: Set<string>;
};

type WatchTargetCacheEntry = {
  signature: string;
  targets: WatchTarget[];
};

const log = createSubsystemLogger("gateway/skills");
// Gateway startup imports this owner before serving turns. Shared watcher handles,
// including later rebuilds, must inherit that lifetime rather than the triggering turn.
const runInSkillsWatcherContext = AsyncLocalStorage.snapshot();
const SKILLS_WATCH_DEBOUNCE_MS = 250;
// One watcher per unique watched directory. Agent workspaces that include the
// same shared skill root (the global skills dir, the home skills dir, or a
// configured extra/plugin dir) subscribe to the same watcher instead of each
// opening its own, so open file descriptors scale with distinct directories
// rather than with agent count.
const pathWatchers = new Map<string, SkillsPathWatchState>();
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
const workspaceWatchTargetCache = new Map<string, WatchTargetCacheEntry>();
const workspaceWatchLastEnsuredAt = new Map<string, number>();
// Session turns re-ensure their workspace; entries older than this are treated
// as abandoned subscriptions and evicted by the next ensure call.
const SKILLS_WORKSPACE_WATCH_IDLE_TTL_MS = 60 * 60_000;
const MAX_SKILLS_WORKSPACE_WATCH_STATES = 128;

setSkillsChangeListenerErrorHandler((err) => {
  log.warn(`skills change listener failed: ${String(err)}`);
});

function resolveWatchTargets(
  workspaceDir: string,
  config: OpenClawConfig | undefined,
  agentId: string | undefined,
  executionWorkspaceDir: string | undefined,
  watcherKey: string,
  pluginMetadataSnapshot: PluginMetadataSnapshot | undefined,
): WatchTarget[] {
  const baseRoots = resolveWorkspaceSkillDirectories(workspaceDir).map(({ dir, source }) => ({
    path: dir,
    source,
  }));
  const executionRoots = executionWorkspaceDir
    ? resolveWorkspaceSkillDirectories(executionWorkspaceDir)
    : [];
  baseRoots.push(...resolveWorkshopWatchRoots(config, agentId));
  baseRoots.push({ path: path.join(CONFIG_DIR, "skills"), source: "openclaw-managed" });
  if (isDefaultStateDir()) {
    baseRoots.push({
      path: path.join(os.homedir(), ".agents", "skills"),
      source: "agents-skills-personal",
    });
  }
  const extraDirsRaw = config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => normalizeOptionalString(d) ?? "")
    .filter(Boolean)
    .map((dir) => resolveUserPath(dir));
  const pluginSkillRoots = pluginMetadataSnapshot
    ? resolvePluginSkillRootsFromMetadata({
        workspaceDir,
        config,
        metadataSnapshot: pluginMetadataSnapshot,
      })
    : resolvePluginSkillRoots({ workspaceDir, config });
  const pluginSkillDirs = pluginSkillRoots.map((root) => root.dir);
  const allowedSymlinkTargetRealPaths = resolveAllowedSkillSymlinkTargetRealPaths(config);
  const signature = JSON.stringify({
    basePaths: baseRoots.map((root) => toWatchRoot(root.path)),
    executionPaths: executionRoots.map((root) => toWatchRoot(root.dir)),
    extraDirs: extraDirs.map(toWatchRoot),
    pluginSkillDirs: pluginSkillDirs.map(toWatchRoot),
    allowSymlinkTargets: allowedSymlinkTargetRealPaths,
  });
  const cached = workspaceWatchTargetCache.get(watcherKey);
  if (cached?.signature === signature) {
    return cached.targets;
  }

  const targets = new Map<string, WatchTarget>();
  for (const root of baseRoots) {
    addSkillSourceWatchTargets(
      targets,
      root.path,
      root.source,
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
    );
  }
  for (const resolved of extraDirs) {
    addSkillSourceWatchTargets(targets, resolved, "openclaw-extra", allowedSymlinkTargetRealPaths);
  }
  for (const dir of pluginSkillDirs) {
    addSkillSourceWatchTargets(targets, dir, "openclaw-plugin", allowedSymlinkTargetRealPaths);
  }
  const executionTargets = new Map<string, WatchTarget>();
  for (const root of executionRoots) {
    addSkillSourceWatchTargets(
      executionTargets,
      root.dir,
      root.source,
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
    );
  }
  for (const [key, target] of executionTargets) {
    const shared = targets.get(key);
    if (shared) {
      shared.depth = Math.max(shared.depth, target.depth);
    } else {
      targets.set(key, { ...target, executionOnly: true });
    }
  }
  const sortedTargets = Array.from(targets.values()).toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );
  workspaceWatchTargetCache.set(watcherKey, { signature, targets: sortedTargets });
  return sortedTargets;
}

function createSkillsPathWatcher(
  target: WatchTarget,
  previousAncestorRoot = target.watchRoot,
): SkillsPathWatchState {
  const usePolling = resolveSkillsWatcherUsePolling();
  const pathFilter = createSkillsWatchPathFilter(target.path, usePolling);
  // Descendant native watches do not report ancestor moves. Keep shallow
  // observation along the original path even after its content watch promotes.
  const ancestorRoot = isPathInside(previousAncestorRoot, target.watchRoot)
    ? previousAncestorRoot
    : target.watchRoot;
  const ancestorRoots: string[] = [];
  let currentRoot = target.watchRoot;
  while (isPathInside(ancestorRoot, currentRoot)) {
    if (currentRoot !== target.path) {
      ancestorRoots.push(currentRoot);
    }
    const parent = toWatchRoot(path.dirname(currentRoot));
    if (parent === currentRoot) {
      break;
    }
    currentRoot = parent;
  }
  const pendingAncestors = new Set(ancestorRoots);
  let contentReady = target.path !== target.watchRoot;
  const watcher =
    target.path === target.watchRoot
      ? runInSkillsWatcherContext(() =>
          chokidar.watch(target.path, {
            ignoreInitial: true,
            followSymlinks: false,
            usePolling,
            // Identity metadata sits one level below the deepest admitted skill.
            depth: target.depth + 1,
            awaitWriteFinish: {
              stabilityThreshold: SKILLS_WATCH_DEBOUNCE_MS,
              pollInterval: 100,
            },
            ignored: pathFilter.ignored,
          }),
        )
      : undefined;
  const releaseAncestors: (() => void)[] = [];
  const state: SkillsPathWatchState = {
    closed: false,
    close: () => {
      if (state.closed) {
        return;
      }
      state.closed = true;
      clearTimeout(state.timer);
      if (watcher) {
        void teardownSkillsPathWatcher({ watcher });
      }
      for (const release of releaseAncestors) {
        release();
      }
    },
    schedule: (changedPath) => schedule(changedPath),
    watchRoot: target.watchRoot,
    ancestorRoot,
    depth: target.depth,
    initialScan: "pending",
    subscribers: new Set<string>(),
  };
  const isCurrent = () => !state.closed && pathWatchers.get(target.path) === state;
  const reconcileRoot = (changedPath?: string) => {
    if (!isCurrent()) {
      return true;
    }
    const nextTarget = makeSkillsWatchTarget(target.path, state.depth, state.ancestorRoot);
    if (nextTarget.watchRoot === state.watchRoot) {
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
      subscribeWorkspaceToPath(subscriber, nextTarget);
      if (changedPath) {
        pathWatchers.get(target.path)?.schedule(changedPath);
      }
    }
    return true;
  };

  const publishChanges = (
    watcherKeys: Iterable<string>,
    changedPath?: string,
    change: SkillsWatchChange | "initial-scan" = "skills",
  ) => {
    const initialScan = change === "initial-scan";
    const affected = new Map<string, SkillsSourceScope[] | undefined>();
    for (const watcherKey of watcherKeys) {
      if (change !== "supporting") {
        workspaceWatchTargetCache.delete(watcherKey);
      }
      const owner = workspaceWatchOwners.get(watcherKey);
      if (!owner) {
        continue;
      }
      const shared = initialScan
        ? owner.sharedScanPending
        : workspaceWatchTargets.get(watcherKey)?.find((entry) => entry.path === target.path)
            ?.executionOnly !== true;
      if (initialScan) {
        owner.sharedScanPending &&= (workspaceWatchTargets.get(watcherKey) ?? []).some(
          (entry) => !entry.executionOnly && pathWatchers.get(entry.path)?.initialScan !== "ready",
        );
      }
      if (shared) {
        affected.set(owner.workspaceDir, undefined);
        continue;
      }
      if (affected.has(owner.workspaceDir) && !affected.get(owner.workspaceDir)) {
        continue;
      }
      const scopes = affected.get(owner.workspaceDir) ?? [];
      scopes.push(owner.sourceScope);
      affected.set(owner.workspaceDir, scopes);
    }
    for (const [workspaceDir, sourceScopes] of affected) {
      if (change === "supporting") {
        markSkillsSupportingFilesChanged({ workspaceDir, sourceScopes });
      } else {
        bumpSkillsSnapshotVersion({ workspaceDir, sourceScopes, reason: "watch", changedPath });
      }
    }
  };
  const settleInitialScan = (result: "ready" | "error") => {
    if (!isCurrent() || state.initialScan === "ready" || state.initialScan === result) {
      return;
    }
    state.initialScan = result;
    const readySubscribers: string[] = [];
    for (const watcherKey of state.subscribers) {
      const targets = workspaceWatchTargets.get(watcherKey);
      if (
        targets?.every((entry) => {
          const current = pathWatchers.get(entry.path);
          return current && !current.closed && current.initialScan !== "pending";
        })
      ) {
        readySubscribers.push(watcherKey);
      }
    }
    publishChanges(readySubscribers, undefined, "initial-scan");
  };

  const schedule = (changedPath?: string, change: SkillsWatchChange = "skills") => {
    // File-stability work may finish after this subscription has been closed.
    if (!isCurrent() || (change === "supporting" && state.pendingChange === "skills")) {
      return;
    }
    state.pendingPath = changedPath ?? state.pendingPath;
    state.pendingChange = change;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (!isCurrent()) {
        return;
      }
      const pendingPath = state.pendingPath;
      const pendingChange = state.pendingChange;
      state.pendingPath = undefined;
      state.pendingChange = undefined;
      state.timer = undefined;
      // Fan the change out to every workspace subscribed to this directory so a
      // shared skill root refreshes the snapshot for all agents that use it.
      publishChanges(state.subscribers, pendingPath, pendingChange);
    }, SKILLS_WATCH_DEBOUNCE_MS);
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
  const ready = () => {
    if (!reconcileRoot() && contentReady && pendingAncestors.size === 0) {
      settleInitialScan("ready");
    }
  };
  watcher?.on("ready", () => {
    contentReady = true;
    ready();
  });
  const onChange = (event: string, changedPath: string) => {
    if (
      !isCurrent() ||
      ((!watcher || event === "addDir" || event === "unlinkDir") && reconcileRoot(changedPath))
    ) {
      return;
    }
    const skillsRelevant = pathFilter.isRelevant(event, changedPath);
    if (skillsRelevant || pathFilter.isSupportingPath(changedPath)) {
      schedule(changedPath, skillsRelevant ? "skills" : "supporting");
    }
  };
  watcher?.on("all", onChange);
  const onRaw = (_eventName: string, rawPath: unknown, details: unknown) => {
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
  watcher?.on("raw", onRaw);
  const onError = (err: unknown) => {
    if (!isCurrent()) {
      return;
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
      }
      return;
    }
    log.warn(`skills watcher error (${target.path}): ${String(err)}`);
    // A failed scan may never emit ready. Let healthy roots reconcile; if the
    // failed scan continues, its eventual ready still closes that read gap.
    settleInitialScan("error");
  };
  watcher?.on("error", onError);
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
        raw: onRaw,
        error: (error) => {
          pendingAncestors.delete(root);
          onError(error);
          // Missing roots still need the ancestor's recovery scan.
          if (watcher) {
            ready();
          }
        },
      }).release,
    );
  }

  return state;
}

function subscribeWorkspaceToPath(workspaceDir: string, watchTarget: WatchTarget): void {
  const existing = pathWatchers.get(watchTarget.path);
  if (
    existing &&
    existing.watchRoot === watchTarget.watchRoot &&
    existing.depth >= watchTarget.depth
  ) {
    existing.subscribers.add(workspaceDir);
    return;
  }
  if (existing) {
    // A changed ancestor or deeper target needs a rebuilt watcher, preserving subscribers.
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
    existing.close();
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
  if (nativeWatchCapacityFailed) {
    // Reconcile file-backed sources during preparation while native observation
    // is unavailable, without reopening watches.
    workspaceWatchTargetCache.delete(watcherKey);
    bumpSkillsSnapshotVersion({ workspaceDir, refreshInputs, reason: "watch" });
    return;
  }
  const watchTargets = resolveWatchTargets(
    workspaceDir,
    params.config,
    params.agentId,
    executionWorkspaceDir,
    watcherKey,
    params.pluginMetadataSnapshot,
  );
  // resolveWatchTargets returns stable sorted order, so positional equality is intentional.
  const targetsMatch = (previous: WatchTarget, next: WatchTarget) =>
    previous.path === next.path &&
    previous.watchRoot === next.watchRoot &&
    previous.depth === next.depth &&
    previous.executionOnly === next.executionOnly;
  const targetsUnchanged = areOrderedArraysEqual(previousTargets, watchTargets, targetsMatch);
  const watcherDepthsCoverTargets = watchTargets.every(
    (watchTarget) => (pathWatchers.get(watchTarget.path)?.depth ?? -1) >= watchTarget.depth,
  );
  if (targetsUnchanged && watcherDepthsCoverTargets) {
    return;
  }
  const coveredTargets = previousTargets.length
    ? previousTargets
    : Array.from(workspaceWatchOwners).flatMap(([key, other]) =>
        other.workspaceDir === workspaceDir ? (workspaceWatchTargets.get(key) ?? []) : [],
      );
  const sharedTargetsChanged =
    watchTargets.some(
      (target) =>
        !target.executionOnly && !coveredTargets.some((previous) => targetsMatch(previous, target)),
    ) ||
    previousTargets.some(
      (previous) =>
        !previous.executionOnly && !watchTargets.some((target) => targetsMatch(previous, target)),
    );
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
  owner.sharedScanPending ||= watchTargets.some(
    (target) => !target.executionOnly && pathWatchers.get(target.path)?.initialScan !== "ready",
  );

  // Acquisition must invalidate reads cached during an unwatched interval,
  // before the first consumer runs or the asynchronous initial scan completes.
  if (!targetsUnchanged) {
    bumpSkillsSnapshotVersion({
      workspaceDir,
      sourceScopes: sharedTargetsChanged ? undefined : [sourceScope],
      refreshInputs,
      reason: "watch-targets",
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
  await joinSkillsWatcherCloses();
}
