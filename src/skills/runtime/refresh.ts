import { AsyncLocalStorage } from "node:async_hooks";
import { ok, type Result } from "@openclaw/normalization-core/result";
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
import {
  acquireSkillsAncestorWatcher,
  resetSkillsAncestorWatchersForTest,
} from "./refresh-ancestor-watch.js";
import { createSkillsContentWatcher } from "./refresh-content-watch.js";
import { createRawSkillFileScheduler } from "./refresh-file-stability.js";
import {
  closeRemoteSkillsWatchers,
  disposeRemoteSkillsWatcher,
  ensureRemoteSkillsWatcher,
} from "./refresh-remote.js";
import {
  bumpSkillsSnapshotVersion,
  resetSkillsRefreshStateForTest,
  setSkillsChangeListenerErrorHandler,
  suspendSkillsSnapshotSources,
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
  flushSkillsWatchChanges,
  hasUncertainPooledCoverage,
  hasUnreadySharedTargets,
  hasVerifiedCoverage,
  pathWatchers,
  publishRecoveredCoverage,
  publishSkillsWatchChanges,
  recordPooledObservationLoss,
  uncertainPooledObservationRoots,
  unsubscribeWorkspaceFromPath,
  workspaceWatchOwners,
  workspaceWatchTargetCache,
  workspaceWatchTargets,
  type PendingSkillsWatchChange,
  type SkillsPathWatchState,
  type SkillsWatchChange,
} from "./refresh-watch-registry.js";
import {
  compareSkillsWatchTargets,
  resolveSkillsWatchTargets,
  type WatchTarget,
} from "./refresh-watch-targets.js";
import {
  createSkillsContentWatchFactory,
  shouldUseNativeSkillsWatcher,
} from "./refresh-watch-transport.js";
export { registerSkillsChangeListener } from "./refresh-state.js";

const log = createSubsystemLogger("gateway/skills");
// Gateway startup imports this owner before serving turns. Shared watcher handles,
// including later rebuilds, must inherit that lifetime rather than the triggering turn.
const watchContent = createSkillsContentWatchFactory(AsyncLocalStorage.snapshot());
const SKILLS_WATCH_DEBOUNCE_MS = 250;
// Failed retirement quarantines only the content owner whose close failed.
// Shared ancestor retirement has its own custody in refresh-ancestor-watch.
const failedContentPaths = new Set<string>();
const retiringWatchers = new Set<Promise<Result<void, unknown>>>();
const replacingWatchers = new Set<Promise<void>>();
let watchersClosing = false;
let nativeWatchCapacityFailed = false;
const workspaceWatchLastEnsuredAt = new Map<string, number>();
// Session turns re-ensure their workspace; entries older than this are treated
// as abandoned subscriptions and evicted by the next ensure call.
const SKILLS_WORKSPACE_WATCH_IDLE_TTL_MS = 60 * 60_000;
const MAX_SKILLS_WORKSPACE_WATCH_STATES = 128;

setSkillsChangeListenerErrorHandler((err) => {
  log.warn(`skills change listener failed: ${String(err)}`);
});

function createSkillsPathWatcher(
  target: WatchTarget,
  previousAncestorRoot = target.watchRoot,
  previous?: SkillsPathWatchState,
): SkillsPathWatchState {
  const usePolling = resolveSkillsWatcherUsePolling();
  const pooledNative = !usePolling && !shouldUseNativeSkillsWatcher(usePolling);
  const pathFilter = createSkillsWatchPathFilter(target.path, usePolling);
  const { ancestorRoot, ancestorRoots } = resolveSkillsWatchAncestors(target, previousAncestorRoot);
  const pendingAncestors = new Set(ancestorRoots);
  let contentReady = target.path !== target.watchRoot;
  let content: ReturnType<typeof createSkillsContentWatcher> | undefined;
  const releaseAncestors: Array<() => Promise<Result<void, unknown>>> = [];
  let closing: Promise<Result<void, unknown>> | undefined;
  const quarantined = failedContentPaths.has(target.path);
  const state: SkillsPathWatchState = {
    closed: false,
    close: () => {
      if (closing) {
        return closing;
      }
      state.closed = true;
      clearTimeout(state.timer);
      const contentClose = content?.close().then((result) => {
        if (!result.ok) {
          failedContentPaths.add(target.path);
        }
        return result;
      });
      closing = Promise.all([
        ...(contentClose ? [contentClose] : []),
        ...releaseAncestors.map((release) => release()),
      ]).then((results) => results.find((result) => !result.ok) ?? ok(undefined));
      retiringWatchers.add(closing);
      void closing.then(() => retiringWatchers.delete(closing!));
      return closing;
    },
    watchRoot: target.watchRoot,
    ancestorRoot,
    depth: target.depth,
    initialScan: quarantined ? "error" : (previous?.initialScan ?? "pending"),
    unavailable:
      quarantined ||
      Boolean(previous?.unavailable) ||
      (pooledNative && hasUncertainPooledCoverage(target.path)),
    pooledNative,
    verified: false,
    failed: quarantined,
    recovering: Boolean(previous?.unavailable),
    replacing: false,
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
    if (
      pooledNative &&
      nextTarget.watchRoot !== state.watchRoot &&
      isPathInside(nextTarget.watchRoot, state.watchRoot)
    ) {
      // Outward retreat proves the old observation root disappeared. Ordinary
      // inward promotion and depth expansion do not establish observation loss.
      recordPooledObservationLoss(state.watchRoot);
    }
    if (changedPath && isCurrent()) {
      // Retirement can stall or fail. Publish the observed change while its
      // subscribers still own this watcher, independently of replacement readiness.
      publishSkillsWatchChanges([{ ...targetChange, changedPath, change: "skills" }]);
    }
    // Either publication can retire this owner synchronously.
    if (!isCurrent()) {
      return true;
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
    const ancestorsSettled = pendingAncestors.size === 0;
    const uncertainCoverage = pooledNative && hasUncertainPooledCoverage(target.path);
    const restored = ancestorsSettled && state.unavailable;
    if (ancestorsSettled) {
      // Ready listings reconcile content, but cannot renew peer-held native handles.
      // Settle logical recovery without repeatedly reopening the same pooled watches.
      state.unavailable = uncertainCoverage;
      state.failed = false;
      state.recovering = false;
      state.verified = !uncertainCoverage;
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
    if (rescan || restored) {
      changes.push({ ...targetChange, change: "skills" });
    }
    publishSkillsWatchChanges(changes);
    publishRecoveredCoverage();
  };
  const onChange = (event: string, changedPath: string) => {
    if (!isCurrent()) {
      return;
    }
    if (pooledNative && event === "unlinkDir" && pathFilter.isRelevant(event, changedPath)) {
      // Unlink can arrive after recreation at the same pathname. A new listing
      // cannot certify peer-retained pooled handles for that removed subtree.
      recordPooledObservationLoss(changedPath);
      if (!isCurrent()) {
        return;
      }
    }
    const ancestorChanged = event === "ancestor";
    if (
      (!content || ancestorChanged || event === "addDir" || event === "unlinkDir") &&
      // A coalesced native rename can replace an ancestor and recreate this
      // same path before delivery, leaving the content watch on the old inode.
      reconcileRoot(changedPath, ancestorChanged && Boolean(content))
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
  const onError = (err: unknown, rescan = false, ancestor?: string, observedRoot = ancestor) => {
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
          void active.close();
        }
        for (const workspaceDir of new Set(
          Array.from(workspaceWatchOwners.values(), (owner) => owner.workspaceDir),
        )) {
          bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch-unavailable" });
        }
      }
      return;
    }
    if (pooledNative) {
      recordPooledObservationLoss(observedRoot ?? target.path);
    }
    log.warn(`skills watcher error (${target.path}): ${String(err)}`);
    // Startup settlement and observation availability are separate facts: a
    // later failure must not relatch shared startup fan-in or hide its own gap.
    if (state.initialScan === "pending") {
      state.initialScan = "error";
    }
    const changes: PendingSkillsWatchChange[] = [];
    state.failed = true;
    state.verified = false;
    if (!state.unavailable) {
      state.unavailable = true;
      changes.push({ ...targetChange, change: "unavailable" });
    }
    publishSkillsWatchChanges(changes);
    if (rescan) {
      schedule();
    }
    if (ancestor && !state.recovering) {
      // Retry a failed ancestor once after this owner's retirement. A failed
      // replacement stays unavailable until a later preparation or real change.
      reconcileRoot(undefined, true);
    }
  };
  if (quarantined) {
    return state;
  }
  if (target.path === target.watchRoot) {
    content = createSkillsContentWatcher({
      watch: () => watchContent(target, usePolling, pathFilter.ignored, SKILLS_WATCH_DEBOUNCE_MS),
      isCurrent,
      isStructuralRaw: pathFilter.isStructuralRaw,
      ready: (rescan) => {
        contentReady = true;
        // Verified content can refresh readers while unavailable ancestor observation
        // still prevents this owner from certifying coverage.
        ready(rescan || state.unavailable);
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
          if (!isCurrent()) {
            return;
          }
          const ancestorsRestored = pendingAncestors.delete(root) && pendingAncestors.size === 0;
          if (ancestorsRestored && state.recovering && content) {
            if (reconcileRoot()) {
              return;
            }
            // Verification during an ancestor gap cannot certify descendant handles.
            // Fence any pending scan, then verify under restored ancestor observation.
            contentReady = false;
            content.structureChanged();
            content.rescan();
            return;
          }
          ready();
        },
        unavailable: () => {
          if (!isCurrent()) {
            return;
          }
          pendingAncestors.add(root);
          state.verified = false;
          if (!state.unavailable && state.initialScan === "ready") {
            state.unavailable = true;
            publishSkillsWatchChanges([{ ...targetChange, change: "unavailable" }]);
          }
          // Recovery already owns this ancestor attempt; retiring again would requeue it.
          if (content && !state.recovering) {
            reconcileRoot(undefined, true);
          }
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
        error: (error, observationRoot) => {
          pendingAncestors.add(root);
          onError(error, false, root, observationRoot);
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
  if (existing) {
    existing.subscribers.add(workspaceDir);
    const reusable =
      !existing.closed &&
      !existing.failed &&
      !replaceContent &&
      existing.watchRoot === watchTarget.watchRoot &&
      existing.depth >= watchTarget.depth;
    existing.depth = Math.max(existing.depth, watchTarget.depth);
    if (reusable || existing.replacing) {
      return;
    }
    existing.replacing = true;
    existing.verified = false;
    if (!existing.unavailable) {
      existing.unavailable = true;
      publishSkillsWatchChanges([
        {
          targetPath: watchTarget.path,
          state: existing,
          watcherKeys: existing.subscribers,
          change: "unavailable",
        },
      ]);
    }
    // Keep subscribers on this exact owner while all its generations retire.
    // Releases cancel rearm; late subscribers join the same verified replacement.
    const replacement = existing.close().then((result) => {
      if (
        !result.ok ||
        watchersClosing ||
        nativeWatchCapacityFailed ||
        pathWatchers.get(watchTarget.path) !== existing ||
        existing.subscribers.size === 0
      ) {
        return;
      }
      const target = makeSkillsWatchTarget(watchTarget.path, existing.depth, existing.ancestorRoot);
      const next = createSkillsPathWatcher(target, existing.ancestorRoot, existing);
      for (const subscriber of existing.subscribers) {
        next.subscribers.add(subscriber);
        workspaceWatchTargetCache.delete(subscriber);
        for (const entry of workspaceWatchTargets.get(subscriber) ?? []) {
          if (entry.path === target.path) {
            entry.watchRoot = target.watchRoot;
          }
        }
      }
      pathWatchers.set(target.path, next);
    });
    replacingWatchers.add(replacement);
    void replacement.finally(() => replacingWatchers.delete(replacement));
    return;
  }
  const state = createSkillsPathWatcher(watchTarget);
  state.subscribers.add(workspaceDir);
  pathWatchers.set(watchTarget.path, state);
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
  if (watchersClosing) {
    return;
  }
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
    unavailable: workspaceWatchOwners.get(watcherKey)?.unavailable ?? false,
  };
  workspaceWatchOwners.set(watcherKey, owner);
  const isCurrent = () => !watchersClosing && workspaceWatchOwners.get(watcherKey) === owner;
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
  if (!isCurrent()) {
    return;
  }
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
  if (!isCurrent()) {
    return;
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
  // A replacement notification can synchronously dispose or re-ensure this owner.
  // Publish its full plan first so disposal also releases the admitted prefix.
  workspaceWatchTargets.set(watcherKey, watchTargets);
  for (const watchTarget of watchTargets) {
    subscribeWorkspaceToPath(watcherKey, watchTarget);
    if (!isCurrent()) {
      return;
    }
  }
  owner.sharedScanPending ||= hasUnreadySharedTargets(watcherKey);
  const joinedUnavailable = watchTargets.some(
    (target) =>
      pathWatchers.get(target.path)?.unavailable &&
      !previousTargets.some((previous) => previous.path === target.path),
  );

  const notifyUnavailable = joinedUnavailable && !owner.unavailable;
  owner.unavailable ||= joinedUnavailable;

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
      reason: notifyUnavailable ? "watch-unavailable" : "watch-targets",
      changedPath: watchTargets.map((target) => target.path).join("|"),
    });
  }
}

/** Finish discovery deferred during an outage before a worker advertises coverage. */
export function reconcileSkillsWatcherCoverage(
  params: Parameters<typeof ensureSkillsWatcher>[0],
): boolean {
  ensureSkillsWatcher(params);
  const workspaceDir = params.workspaceDir.trim();
  const { executionWorkspaceDir } = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: params.executionWorkspaceDir,
  });
  const watcherKey = JSON.stringify([workspaceDir, executionWorkspaceDir, params.agentId]);
  const owner = workspaceWatchOwners.get(watcherKey);
  const covered = !watchersClosing && !nativeWatchCapacityFailed && hasVerifiedCoverage(watcherKey);
  if (owner && !covered) {
    // New targets need their own verification; their ready event resumes this
    // availability check after discovery and outage edits have been reconciled.
    owner.unavailable = true;
  }
  return covered;
}

export async function closeSkillsWatchers(resetState = false): Promise<void> {
  watchersClosing = true;
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
    void state.close();
  }
  await Promise.all([
    ...replacingWatchers,
    ...retiringWatchers,
    joinSkillsWatcherCloses(),
    closeRemoteSkillsWatchers(),
  ]);
  watchersClosing = false;
  if (resetState) {
    failedContentPaths.clear();
    uncertainPooledObservationRoots.clear();
    resetSkillsAncestorWatchersForTest();
  }
}
