import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import {
  watch,
  type WatchHealth,
  type WatchScope,
  type WatchSubscription,
} from "@openclaw/fs-safe/watch";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveFsObservationMode,
  resolveFsObservationIntervalMs,
} from "../../infra/fs-observation-mode.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { normalizeWorkspaceSkillRoots } from "../loading/workspace-skill-roots.js";
import {
  resolveWorkspaceSkillSourcePlan,
  splitSkillSourcePlan,
  type WorkspaceSkillSourcePlan,
} from "../loading/workspace-skill-sources.js";
import { createSkillFileScheduler, SkillFileSampleCloseError } from "./refresh-file-stability.js";
import {
  admitSkillsObservationRoot,
  skillsObservationScope,
} from "./refresh-observation-source.js";
import {
  closeRemoteSkillsWatchers,
  disposeRemoteSkillsWatcher,
  ensureRemoteSkillsWatcher,
} from "./refresh-remote.js";
import {
  bumpSkillsSnapshotVersion,
  resetSkillsRefreshStateForTest,
  setSkillsChangeListenerErrorHandler,
} from "./refresh-state.js";
import { isIgnoredSkillsWatchPath, isSkillDiscoveryFileWatchPath } from "./refresh-watch-path.js";
import {
  evictWorkspaceWatchStates,
  flushSkillsWatchChanges,
  hasUnreadySharedTargets,
  hasVerifiedCoverage,
  pathWatchers,
  publishRecoveredCoverage,
  publishSkillsWatchChanges,
  unsubscribeWorkspaceFromPath,
  workspaceWatchLastEnsuredAt,
  workspaceWatchOwners,
  workspaceWatchTargetCache,
  workspaceWatchTargets,
  type PendingSkillsWatchChange,
  type SkillsPathWatchState,
  type SkillsWatchChange,
  type SkillsWatchOwner,
} from "./refresh-watch-registry.js";
import {
  compareSkillsWatchTargets,
  resolveSkillsWatchTargets,
  type WatchTarget,
} from "./refresh-watch-targets.js";
export { registerSkillsChangeListener } from "./refresh-state.js";

const log = createSubsystemLogger("gateway/skills");
// Gateway startup imports this owner before serving turns. Shared watcher handles,
// including later rebuilds, must inherit that lifetime rather than the triggering turn.
const runInSkillsWatcherContext = AsyncLocalStorage.snapshot();
const SKILLS_WATCH_DEBOUNCE_MS = 250;
const retiringWatchers = new Set<Promise<void>>();
const replacingWatchers = new Set<Promise<void>>();
let watchersClosing = false;
let nativeWatchCapacityFailed = false;
// Optional classification detail, not an observation inventory or read authority.
// Overflow conservatively invalidates discovery instead of retaining more names.
const MAX_SKILLS_WATCH_ENTRY_KINDS = 4096;

setSkillsChangeListenerErrorHandler((err) => {
  log.warn(`skills change listener failed: ${String(err)}`);
});

function createSkillsPathWatcher(
  target: WatchTarget,
  previous?: SkillsPathWatchState,
): SkillsPathWatchState {
  const lifetime = new AbortController();
  let subscription: WatchSubscription | undefined;
  let subscriptionReady = false;
  let plannedScope: WatchScope | undefined;
  let entryDirectoryObserved = false;
  // true means a directory/link/other entry was seen. Keep both sides of a
  // reconciliation so directory -> file and deletion cannot look supporting-only.
  // Unioning scan passes is intentionally conservative for transient structure.
  let entryKinds: Map<string, boolean> | undefined = new Map();
  let scannedKinds: Map<string, boolean> | undefined = new Map();
  const construction = createDeferredCore();
  const retireSubscription = async () => {
    await subscription?.close();
  };
  let starting = Promise.resolve();
  let closing: Promise<void> | undefined;
  const state: SkillsPathWatchState = {
    closed: false,
    depth: target.depth,
    authority: previous?.authority,
    initialScan: previous?.initialScan ?? "pending",
    unavailable: Boolean(previous?.unavailable),
    verified: false,
    failed: false,
    recovering: Boolean(previous?.unavailable),
    replacing: false,
    subscribers: new Set(),
    close() {
      if (closing) {
        return closing;
      }
      const done = createDeferredCore();
      // Enroll before abort/close or a listener can synchronously reenter shutdown.
      closing = done.promise;
      retiringWatchers.add(closing);
      void closing.then(
        () => retiringWatchers.delete(closing!),
        () => {},
      );
      state.closed = true;
      state.verified = false;
      lifetime.abort();
      clearTimeout(state.timer);
      const retiring = subscription
        ? retireSubscription()
        : construction.promise.then(retireSubscription);
      const settling = stability.close();
      void Promise.allSettled([starting, retiring, settling]).then(([, retired, settled]) => {
        const errors = [retired, settled].flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length) {
          done.reject(new AggregateError(errors, "Skills observation retirement failed"));
        } else {
          done.resolve();
        }
      });
      return closing;
    },
  };
  const isCurrent = () => !state.closed && pathWatchers.get(target.path) === state;
  const targetChange = { targetPath: target.path, state, watcherKeys: state.subscribers };
  const schedule = (changedPath?: string, change: SkillsWatchChange = "skills") => {
    if (!isCurrent() || (change === "supporting" && state.pendingChange === "skills")) {
      return;
    }
    state.pendingPath = changedPath ?? state.pendingPath;
    state.pendingChange = change;
    clearTimeout(state.timer);
    state.pendingAt = performance.now() + SKILLS_WATCH_DEBOUNCE_MS;
    state.timer = setTimeout(() => flushSkillsWatchChanges(state), SKILLS_WATCH_DEBOUNCE_MS);
  };
  const stability = createSkillFileScheduler({
    stabilityMs: SKILLS_WATCH_DEBOUNCE_MS,
    sample: async (changedPath) => {
      const authority = await state.authority;
      if (!authority || !isCurrent()) {
        return undefined;
      }
      let opened;
      try {
        opened = await authority.open("./" + path.relative(authority.rootDir, changedPath), {
          symlinks: "reject",
        });
      } catch {
        return undefined;
      }
      // Metadata was captured by open(). Join cleanup before accessing that
      // snapshot so an observation error cannot hide a descriptor-close failure.
      try {
        await opened[Symbol.asyncDispose]();
      } catch (error) {
        throw new SkillFileSampleCloseError(error);
      }
      return { size: opened.stat.size, mtimeMs: opened.stat.mtimeMs };
    },
    schedule: (changedPath) => schedule(changedPath),
    onError: (changedPath, error) =>
      log.warn("skills watcher stability check failed (" + changedPath + "): " + String(error)),
  });
  const failed = (error: unknown, failure?: WatchHealth["failure"]) => {
    if (!isCurrent() || state.failed) {
      return;
    }
    state.failed = true;
    state.verified = false;
    const capacity =
      failure?.operation === "watch" &&
      ["watch-limit", "EMFILE", "ENFILE"].includes(failure.code ?? "");
    if (capacity && resolveFsObservationMode() !== "poll") {
      if (!nativeWatchCapacityFailed) {
        nativeWatchCapacityFailed = true;
        log.warn(
          "skills native watcher capacity exhausted (" +
            failure?.code +
            "); refreshing skills during agent preparation",
        );
        for (const active of pathWatchers.values()) {
          void active.close().catch((closeError: unknown) => log.warn(String(closeError)));
        }
        for (const workspaceDir of new Set(
          [...workspaceWatchOwners.values()].map((owner) => owner.workspaceDir),
        )) {
          bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch-unavailable" });
        }
      }
      return;
    }
    log.warn("skills watcher error (" + target.path + "): " + String(error));
    if (state.initialScan === "pending") {
      state.initialScan = "error";
    }
    if (!state.unavailable) {
      state.unavailable = true;
      publishSkillsWatchChanges([{ ...targetChange, change: "unavailable" }]);
    } else {
      publishSkillsWatchChanges([{ ...targetChange, change: "skills" }]);
    }
    // A fresh physical subscription gets one automatic recovery attempt. Later
    // preparation may retry under the same pinned Root; close failure never rearms.
    const subscriber = state.subscribers.values().next().value;
    if (isCurrent() && !state.recovering && subscriber !== undefined) {
      subscribeWorkspaceToPath(subscriber, target);
    }
  };
  starting = runInSkillsWatcherContext(() =>
    Promise.resolve().then(async () => {
      try {
        if (!isCurrent()) {
          return;
        }
        if (!state.authority) {
          const admission = admitSkillsObservationRoot(target);
          state.authority = admission;
          void admission.catch(() => {
            if (state.authority === admission) {
              state.authority = undefined;
            }
          });
        }
        const authority = await state.authority;
        if (!isCurrent()) {
          return;
        }
        const scope = await skillsObservationScope(authority, target, lifetime.signal);
        plannedScope = scope;
        if (!isCurrent()) {
          return;
        }
        const mode = resolveFsObservationMode();
        subscription = watch(authority, {
          scopes: [scope],
          mode,
          intervalMs: mode === "poll" ? resolveFsObservationIntervalMs() : undefined,
          signal: lifetime.signal,
          exclude: (entry) => {
            if (scope.kind === "entry" && entry.path === scope.path) {
              entryDirectoryObserved = entry.kind === "directory";
            }
            const absolute = path.resolve(authority.rootDir, entry.path);
            // Ancestors belong to observation plumbing. An explicitly admitted
            // source under .cache (or another ignored parent) still needs coverage.
            const inside = isPathInside(target.path, absolute);
            const ignored =
              inside && isIgnoredSkillsWatchPath(path.relative(target.path, absolute));
            if (inside && !ignored && scannedKinds) {
              if (
                !scannedKinds.has(entry.path) &&
                scannedKinds.size >= MAX_SKILLS_WATCH_ENTRY_KINDS
              ) {
                scannedKinds = undefined;
              } else {
                scannedKinds.set(
                  entry.path,
                  scannedKinds.get(entry.path) === true || entry.kind !== "file",
                );
              }
            }
            return ignored;
          },
          onInvalidate: (hint) => {
            if (!isCurrent()) {
              return;
            }
            if (
              subscriptionReady &&
              scope.kind === "entry" &&
              (!hint.changes || hint.changes.some((change) => change.type === "structural"))
            ) {
              // A blocked lexical entry can become a directory (or retarget).
              // Re-admit the selected scope under the same Root, not a new authority.
              publishSkillsWatchChanges([
                { ...targetChange, changedPath: target.path, change: "skills" },
              ]);
              const subscriber = state.subscribers.values().next().value;
              if (isCurrent() && subscriber !== undefined) {
                subscribeWorkspaceToPath(subscriber, target, true);
              }
              return;
            }
            if (state.initialScan === "pending") {
              return;
            }
            if (!hint.changes) {
              schedule(target.path);
              return;
            }
            for (const change of hint.changes) {
              const changedPath = path.resolve(authority.rootDir, change.path);
              const inside = isPathInside(target.path, changedPath);
              const relative = path.relative(target.path, changedPath);
              if (inside && isIgnoredSkillsWatchPath(relative)) {
                continue;
              }
              if (
                !inside &&
                !(change.type === "structural" && isPathInside(changedPath, target.path))
              ) {
                continue;
              }
              if (
                isSkillDiscoveryFileWatchPath(relative) &&
                (change.type === "content" || scannedKinds?.has(change.path) !== false)
              ) {
                // Creation and atomic replacement can precede more writes. Only
                // a scan-confirmed deletion may bypass guarded write settling.
                stability.schedule(changedPath);
              } else if (change.type === "structural") {
                const before = entryKinds?.get(change.path);
                const after = scannedKinds?.get(change.path);
                const supportingFile =
                  inside &&
                  relative !== "" &&
                  !isSkillDiscoveryFileWatchPath(relative) &&
                  entryKinds !== undefined &&
                  scannedKinds !== undefined &&
                  before !== true &&
                  after !== true &&
                  (before === false || after === false);
                // File creation, deletion and atomic save are structural to fs-safe,
                // but only directories/links/discovery files change Skills discovery.
                schedule(changedPath, supportingFile ? "supporting" : "skills");
              } else {
                schedule(changedPath, "supporting");
              }
            }
          },
          onHealth: (health) => {
            if (health.state === "starting" || health.state === "reconciling") {
              scannedKinds = new Map();
            } else if (health.state === "ready") {
              entryKinds = scannedKinds;
              scannedKinds = new Map();
            }
            if (health.state === "unavailable") {
              failed(health.failure?.error, health.failure);
            }
          },
        });
      } finally {
        // A synchronous health callback can retire the owner before watch()
        // returns its handle. Unblock actual close before waiting for ready.
        construction.resolve();
      }
      await subscription.ready;
      if (!isCurrent()) {
        return;
      }
      subscriptionReady = true;
      if (plannedScope?.kind === "entry" && entryDirectoryObserved) {
        // The guarded admission scan, not the earlier scope probe, observed a
        // directory. No later event is owed for this startup transition. Replan
        // under the same pinned Root and join retirement before claiming coverage.
        const subscriber = state.subscribers.values().next().value;
        if (subscriber !== undefined) {
          subscribeWorkspaceToPath(subscriber, target, true);
        }
        return;
      }
      // The initial guarded scan can admit links absent from target planning,
      // including a tree/missing leaf replaced before watch() started. Re-run
      // the existing bounded target owner before any coverage publication; new
      // canonical targets must finish their own observation first. Existing
      // path owners (and their pinned Roots) remain intact.
      // oxlint-disable-next-line unicorn/no-useless-spread -- Reentrant discovery can remove/re-add owners; only this captured subscriber set belongs to the handoff.
      for (const subscriber of [...state.subscribers]) {
        if (!isCurrent()) {
          return;
        }
        workspaceWatchOwners.get(subscriber)?.reconcileTargets?.();
      }
      if (!isCurrent()) {
        return;
      }
      const restored = state.unavailable;
      state.unavailable = false;
      state.failed = false;
      state.recovering = false;
      state.verified = true;
      const changes: PendingSkillsWatchChange[] = [];
      if (state.initialScan !== "ready") {
        state.initialScan = "ready";
        const watcherKeys = [...state.subscribers].filter((key) =>
          workspaceWatchTargets.get(key)?.every((entry) => {
            const current = pathWatchers.get(entry.path);
            return current && !current.closed && current.initialScan !== "pending";
          }),
        );
        changes.push({ ...targetChange, watcherKeys, change: "initial-scan" });
      }
      if (restored) {
        changes.push({ ...targetChange, change: "skills" });
      }
      publishSkillsWatchChanges(changes);
      publishRecoveredCoverage();
    }),
  );
  void starting.catch((error: unknown) => failed(error, subscription?.health().failure));
  return state;
}

function subscribeWorkspaceToPath(
  workspaceDir: string,
  target: WatchTarget,
  changedScope = false,
): void {
  const existing = pathWatchers.get(target.path);
  if (existing) {
    existing.subscribers.add(workspaceDir);
    const reusable =
      !changedScope && !existing.closed && !existing.failed && existing.depth >= target.depth;
    existing.depth = Math.max(existing.depth, target.depth);
    if (reusable || existing.replacing) {
      return;
    }
    existing.replacing = true;
    existing.verified = false;
    if (!existing.unavailable) {
      existing.unavailable = true;
      publishSkillsWatchChanges([
        {
          targetPath: target.path,
          state: existing,
          watcherKeys: existing.subscribers,
          change: "unavailable",
        },
      ]);
    }
    const replacement = existing
      .close()
      .then(() => {
        if (
          watchersClosing ||
          nativeWatchCapacityFailed ||
          pathWatchers.get(target.path) !== existing ||
          existing.subscribers.size === 0
        ) {
          return;
        }
        const next = createSkillsPathWatcher({ ...target, depth: existing.depth }, existing);
        for (const subscriber of existing.subscribers) {
          next.subscribers.add(subscriber);
          workspaceWatchTargetCache.delete(subscriber);
        }
        pathWatchers.set(target.path, next);
      })
      .catch((error: unknown) =>
        log.warn("skills observation retirement failed (" + target.path + "): " + String(error)),
      );
    replacingWatchers.add(replacement);
    void replacement.finally(() => replacingWatchers.delete(replacement));
    return;
  }
  const state = createSkillsPathWatcher(target);
  state.subscribers.add(workspaceDir);
  pathWatchers.set(target.path, state);
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
  const owner: SkillsWatchOwner = {
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
  if (!watchEnabled) {
    disposeWorkspaceWatchState(watcherKey);
    evictWorkspaceWatchStates(now, disposeWorkspaceWatchState);
    return;
  }

  // Map order breaks equal-clock ties and promotes reuse without adding a generation.
  workspaceWatchLastEnsuredAt.delete(watcherKey);
  workspaceWatchLastEnsuredAt.set(watcherKey, now);
  evictWorkspaceWatchStates(now, disposeWorkspaceWatchState);
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
  const reconcileTargets = (retryFailedTargets: boolean) => {
    const previousTargets = workspaceWatchTargets.get(watcherKey) ?? [];
    const failedTargets = retryFailedTargets
      ? previousTargets.filter((entry) => pathWatchers.get(entry.path)?.unavailable)
      : [];
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
      const existing = pathWatchers.get(watchTarget.path);
      if (!retryFailedTargets && existing?.unavailable && (existing.failed || existing.closed)) {
        // A peer becoming ready must not consume another failed target's retry.
        // Explicit preparation and the failed owner still own recovery admission.
        existing.subscribers.add(watcherKey);
      } else {
        subscribeWorkspaceToPath(watcherKey, watchTarget);
      }
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
          targetChanges.sharedTargetsChanged ||
          failedTargets.some((target) => !target.executionOnly)
            ? undefined
            : [sourceScope],
        refreshInputs,
        // New subscribers need the existing availability fact once. Repeated
        // preparation reconciles content without requeueing a watch-only worker.
        reason: notifyUnavailable ? "watch-unavailable" : "watch-targets",
        changedPath: watchTargets.map((target) => target.path).join("|"),
      });
    }
  };
  owner.reconcileTargets = () => {
    if (!isCurrent() || nativeWatchCapacityFailed) {
      return;
    }
    workspaceWatchTargetCache.delete(watcherKey);
    reconcileTargets(false);
  };
  reconcileTargets(true);
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
    void state.close().catch(() => {});
  }
  const results = await Promise.allSettled([
    ...replacingWatchers,
    ...retiringWatchers,
    closeRemoteSkillsWatchers(),
  ]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) {
    throw new AggregateError(errors, "Skills watcher shutdown failed");
  }
  watchersClosing = false;
}
