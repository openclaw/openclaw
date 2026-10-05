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
import { resolveFsObservationMode } from "../../infra/fs-observation-mode.js";
import { admitObservationRoot } from "../../infra/fs-observation-root.js";
import { readObservationSnapshot } from "../../infra/fs-observation-snapshot.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { clearSkillRootRecordsCache } from "../loading/skill-root-loader.js";
import {
  resolveWorkspaceSkillSourcePlan,
  splitSkillSourcePlan,
  type WorkspaceSkillSourcePlan,
} from "../loading/workspace-skill-sources.js";
import { createSkillFileScheduler } from "./refresh-file-stability.js";
import {
  skillsObservationScope,
  skillsObservationTransport,
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
  clearWorkspaceWatchTargets,
  disposeWorkspacePathWatchState,
  evictWorkspaceWatchStates,
  nextSkillsWatchGeneration,
  resolveSkillsWatchScope,
  flushSkillsWatchChanges,
  hasUnreadySharedTargets,
  hasVerifiedCoverage,
  pathWatchers,
  publishRecoveredCoverage,
  publishSkillsWatchChanges,
  setWorkspaceWatchTargets,
  settleWorkspaceWatchTargetsPlan,
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
  // Exclusion callbacks can cover only a directory slice, so omitted names do
  // not imply deletion. Retain their kinds until observed again or detail fills.
  let entryKinds: Map<string, boolean> | undefined = new Map();
  let scannedKinds: Map<string, boolean> | undefined = new Map();
  let starting = Promise.resolve();
  let closing: Promise<void> | undefined;
  let updating: Promise<void> | undefined;
  let updateRequested = false;
  const state: SkillsPathWatchState = {
    generation: nextSkillsWatchGeneration(),
    closed: false,
    depth: target.depth,
    initialScan: previous?.initialScan ?? "pending",
    unavailable: Boolean(previous?.unavailable),
    verified: false,
    failed: false,
    recovering: Boolean(previous?.unavailable),
    replacing: false,
    subscribers: new Set(),
    refreshScope() {
      updateRequested = true;
      updating ??= runInSkillsWatcherContext(() =>
        Promise.resolve()
          .then(async () => {
            await starting;
            while (updateRequested && isCurrent()) {
              if (!subscription) {
                break;
              }
              updateRequested = false;
              const authority = await state.authority!;
              const scope = await skillsObservationScope(
                authority,
                { ...target, depth: state.depth },
                lifetime.signal,
              );
              if (!isCurrent()) {
                return;
              }
              if (
                scope.path === plannedScope?.path &&
                scope.kind === plannedScope.kind &&
                scope.depth === plannedScope.depth
              ) {
                publishReady();
                continue;
              }
              state.verified = false;
              if (!state.unavailable) {
                state.unavailable = true;
                publishSkillsWatchChanges([{ ...targetChange, change: "unavailable" }]);
              }
              if (!isCurrent()) {
                return;
              }
              plannedScope = scope;
              entryDirectoryObserved = false;
              subscriptionReady = false;
              await subscription.setScopes([scope]);
              subscriptionReady = true;
              if (scope.kind === "entry" && entryDirectoryObserved) {
                updateRequested = true;
              } else if (isCurrent()) {
                publishReady();
              }
            }
          })
          .catch((error: unknown) => {
            updateRequested = false;
            failed(error, subscription?.health().failure);
          })
          .finally(() => {
            updating = undefined;
            if (updateRequested && isCurrent()) {
              void state.refreshScope();
            }
          }),
      );
      return updating;
    },
    close() {
      if (closing) {
        return closing;
      }
      state.closed = true;
      state.verified = false;
      lifetime.abort();
      clearTimeout(state.timer);
      closing = Promise.allSettled([
        starting,
        updating,
        subscription?.close(),
        stability.close(),
      ]).then((results) => {
        const errors = results
          .slice(2)
          .flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
        if (errors.length) {
          throw new AggregateError(errors, "Skills observation retirement failed");
        }
      });
      retiringWatchers.add(closing);
      void closing.then(
        () => retiringWatchers.delete(closing!),
        () => {},
      );
      return closing;
    },
  };
  const isCurrent = () => !state.closed && pathWatchers.get(target.path) === state;
  const targetChange = { targetPath: target.path, state, watcherKeys: state.subscribers };
  const schedule = (changedPath?: string, change: SkillsWatchChange = "skills") => {
    if (!isCurrent() || (change === "supporting" && state.pendingChange === "skills")) {
      return;
    }
    if (change === "skills") {
      state.generation = nextSkillsWatchGeneration();
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
      return await readObservationSnapshot(
        authority,
        path.relative(authority.rootDir, changedPath),
      );
    },
    schedule,
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
    const change = state.unavailable ? "skills" : "unavailable";
    state.unavailable = true;
    publishSkillsWatchChanges([{ ...targetChange, change }]);
    // A fresh subscription gets one automatic recovery attempt. Each replacement
    // re-admits its source after joined retirement; close failure never rearms.
    const subscriber = state.subscribers.values().next().value;
    if (isCurrent() && !state.recovering && subscriber !== undefined) {
      subscribeWorkspaceToPath(subscriber, target);
    }
  };
  const publishReady = () => {
    // Scan-time links need their own admitted target before coverage is ready.
    // Reentrant discovery can replace subscribers; snapshot this handoff's owners.
    for (const subscriber of Array.from(state.subscribers)) {
      if (!isCurrent()) {
        return;
      }
      workspaceWatchOwners.get(subscriber)?.reconcileTargets?.();
    }
    if (!isCurrent() || updateRequested) {
      return;
    }
    const restored = state.unavailable;
    state.unavailable = false;
    state.failed = false;
    state.recovering = false;
    state.verified = true;
    state.generation = nextSkillsWatchGeneration();
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
  };
  starting = runInSkillsWatcherContext(() =>
    Promise.resolve().then(async () => {
      if (!isCurrent()) {
        return;
      }
      state.authority = admitObservationRoot(target.authorityPath);
      const authority = await state.authority;
      if (!isCurrent()) {
        return;
      }
      const scope = await skillsObservationScope(
        authority,
        { ...target, depth: state.depth },
        lifetime.signal,
      );
      plannedScope = scope;
      if (!isCurrent()) {
        return;
      }
      const { mode, pollIntervalMs, reportHealth } = skillsObservationTransport(target.path);
      subscription = watch(authority, {
        scopes: [scope],
        mode,
        pollIntervalMs,
        signal: lifetime.signal,
        exclude: (entry) => {
          if (plannedScope?.kind === "entry" && entry.path === plannedScope.path) {
            entryDirectoryObserved = entry.kind === "directory";
          }
          const absolute = path.resolve(authority.rootDir, entry.path);
          // Ancestors belong to observation plumbing. An explicitly admitted
          // source under .cache (or another ignored parent) still needs coverage.
          const inside = isPathInside(target.path, absolute);
          const ignored = inside && isIgnoredSkillsWatchPath(path.relative(target.path, absolute));
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
            plannedScope?.kind === "entry" &&
            (!hint.changes || hint.changes.some((change) => change.type === "structural"))
          ) {
            // A blocked lexical entry can become a directory (or retarget).
            // Re-admit the selected scope under the same Root, not a new authority.
            state.generation = nextSkillsWatchGeneration();
            publishSkillsWatchChanges([
              { ...targetChange, changedPath: target.path, change: "skills" },
            ]);
            if (isCurrent()) {
              void state.refreshScope();
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
              state.generation = nextSkillsWatchGeneration();
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
          if (isCurrent()) {
            reportHealth(health);
          }
          if (health.state === "starting" || health.state === "reconciling") {
            scannedKinds = new Map();
          } else if (health.state === "ready") {
            if (!scannedKinds) {
              entryKinds = undefined;
            } else if (entryKinds) {
              for (const [name, kind] of scannedKinds) {
                if (!entryKinds.has(name) && entryKinds.size >= MAX_SKILLS_WATCH_ENTRY_KINDS) {
                  entryKinds = undefined;
                  break;
                }
                entryKinds.set(name, kind);
              }
            }
            scannedKinds = new Map();
          }
          if (health.state === "unavailable") {
            failed(health.failure?.error, health.failure);
          }
        },
      });
      await subscription.ready;
      if (!isCurrent()) {
        return;
      }
      subscriptionReady = true;
      if (plannedScope?.kind === "entry" && entryDirectoryObserved) {
        // The baseline can see a directory that replaced the planned blocking entry.
        void state.refreshScope();
        return;
      }
      publishReady();
    }),
  );
  void starting.catch((error: unknown) => failed(error, subscription?.health().failure));
  return state;
}

function subscribeWorkspaceToPath(workspaceDir: string, target: WatchTarget): void {
  const existing = pathWatchers.get(target.path);
  if (existing) {
    existing.subscribers.add(workspaceDir);
    const healthy = !existing.closed && !existing.failed;
    const reusable = healthy && existing.depth >= target.depth;
    existing.depth = Math.max(existing.depth, target.depth);
    if (reusable || existing.replacing) {
      return;
    }
    existing.verified = false;
    if (healthy) {
      // A deeper subscriber cannot claim coverage while scope expansion is pending.
      void existing.refreshScope();
      return;
    }
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
    existing.replacing = true;
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

function disposeWorkspaceWatchState(watcherKey: string): void {
  const watchTargets = workspaceWatchTargets.get(watcherKey) ?? [];
  disposeRemoteSkillsWatcher(watcherKey);
  disposeWorkspacePathWatchState(watcherKey, watchTargets);
}

export function ensureSkillsWatcher(params: {
  workspaceDir: string;
  executionWorkspaceDir?: string;
  executionWorkspaceFileHost?: "gateway";
  config?: OpenClawConfig;
  agentId?: string;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  /** Already admitted roots, mapped into the workspace host filesystem. */
  sourcePlan?: WorkspaceSkillSourcePlan;
}) {
  if (watchersClosing) {
    return;
  }
  const { workspaceDir, executionWorkspaceDir, watcherKey, sourceScope } =
    resolveSkillsWatchScope(params);
  if (!workspaceDir) {
    return;
  }
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
  if (params.config?.skills?.load?.watch === false) {
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
  let localExecutionWorkspaceDir = executionWorkspaceDir;
  if (access?.loadSkills) {
    const {
      gatewayPlan,
      workspacePlan,
      gatewayExecutionWorkspaceDir,
      workspaceExecutionWorkspaceDir,
    } = splitSkillSourcePlan(resolveWorkspaceSkillSourcePlan(workspaceDir, params), sourceScope);
    localExecutionWorkspaceDir = gatewayExecutionWorkspaceDir;
    ensureRemoteSkillsWatcher({
      watcherKey,
      workspaceDir,
      executionWorkspaceDir: workspaceExecutionWorkspaceDir,
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
      localExecutionWorkspaceDir,
      params.pluginMetadataSnapshot,
      localPlan,
      cachedTargets,
    );
    settleWorkspaceWatchTargetsPlan(watcherKey, resolvedTargets);
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
    setWorkspaceWatchTargets(watcherKey, watchTargets);
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
  const { watcherKey } = resolveSkillsWatchScope(params);
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
  clearWorkspaceWatchTargets();
  clearSkillRootRecordsCache();
  workspaceWatchOwners.clear();
  workspaceWatchTargetCache.clear();
  workspaceWatchLastEnsuredAt.clear();
  active.forEach((state) => void state.close());
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
