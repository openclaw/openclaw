import pLimit from "p-limit";
import type { OpenClawConfig } from "../plugin-sdk/config-contracts.js";
import type {
  ControlUiSessionPullRequestSnapshot,
  ControlUiSessionPullRequestsChanged,
  NativeGitHubSessionReads as RepositorySessionReads,
} from "../plugin-sdk/native-github-session-read.js";
import { parseAgentSessionKey } from "../plugin-sdk/routing.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { enqueuePrDelivery } from "./control-ui-session-pr-delivery.js";
import { recordSessionPrDiagnostic } from "./control-ui-session-pr-diagnostics.js";
import {
  createControlUiSessionPrPreparedRead,
  addControlUiSessionPrMembership,
  removeControlUiSessionPrMembership,
  retainControlUiSessionPrBranchSnapshot,
  staleReceiptsOnlyCell,
  createControlUiSessionPrSourceRead,
  type WatchedKeyState,
  type SessionPrScheduler as Scheduler,
  type WatchedSessionPr as Watched,
  loadSessionPullRequests,
  pushedSnapshot,
  UNAVAILABLE_SNAPSHOT,
} from "./control-ui-session-pr-prepared-read.js";
import { createControlUiSessionPrRead } from "./control-ui-session-pr-target.js";
import type { ControlUiSessionPrTarget } from "./control-ui-session-pr-target.js";
import { yieldSessionListWork } from "./session-projection-work.js";
const CONTROL_UI_SESSION_PR_POLL_INTERVAL_MS = 60_000;
const CONTROL_UI_SESSION_PR_REFRESH_INTERVAL_MS = 10_000;
const CONTROL_UI_SESSION_PR_LOAD_CONCURRENCY = 4;

type ScheduledJob = ReturnType<Scheduler["schedule"]>;
type SubscriptionDeps = {
  reads: RepositorySessionReads;
  getConfig: () => OpenClawConfig;
  scheduler: Scheduler;
};

export { parseControlUiSessionPullRequestsSubscribeParams } from "./control-ui-session-pr-subscription-params.js";

/**
 * Owns the union of connection replace-sets. Only this union drives GitHub
 * refreshes, so hidden/disconnected clients cannot leave orphan polling work.
 */
export function createControlUiSessionPullRequestSubscriptions(deps: SubscriptionDeps) {
  const subscriptions = new Map<string, Map<string, Watched>>();
  const replacements = new Set<Promise<void>>();
  type Replacement = { refreshSessionKeys?: ReadonlySet<string> };
  const replacementGenerations = new Map<string, Replacement>();
  const keyStates = new Map<string, WatchedKeyState>();
  const inflight = new Map<
    string,
    {
      promise: Promise<ControlUiSessionPullRequestSnapshot>;
      refresh: boolean;
      state: WatchedKeyState;
    }
  >();
  const scheduler = deps.scheduler.scope();
  const limit = pLimit(CONTROL_UI_SESSION_PR_LOAD_CONCURRENCY);
  // Loads revalidate watchers while holding a slot, so reads use their own bounded queue.
  const limitReads = pLimit(CONTROL_UI_SESSION_PR_LOAD_CONCURRENCY);
  const withSource = createControlUiSessionPrSourceRead({
    reads: deps.reads,
    keyStates,
    currentWatcher: async (connId, sessionKey) => {
      const target = await currentWatcher(connId, sessionKey);
      return target ? { target } : undefined;
    },
  });
  let pollJob: ScheduledJob | undefined;
  const scope = new AsyncWorkScope();
  let stopPromise: Promise<void> | undefined;

  const removeMembership = (
    state: WatchedKeyState | undefined,
    connId: string,
    sessionKey: string,
  ) => removeControlUiSessionPrMembership(state, connId, sessionKey, keyStates);

  const removeMemberships = (
    connId: string,
    previous: ReadonlyMap<string, Watched> | undefined,
    retained?: ReadonlyMap<string, Watched>,
  ) => {
    for (const [key, { target: oldTarget }] of previous ?? []) {
      if (retained?.get(key)?.target.identity !== oldTarget.identity) {
        removeMembership(keyStates.get(oldTarget.identity), connId, key);
      }
    }
  };

  const stateForTarget = (
    target: ControlUiSessionPrTarget,
    sourceIdentity?: string,
    retained?: WatchedKeyState,
  ) => {
    // Shared snapshots outlive individual viewers; authority stays only in each watched reader.
    const { assertCurrent: _assertCurrent, read: _read, ...preparedTarget } = target;
    const previous = keyStates.get(target.identity);
    if (
      previous?.target.identity === target.identity &&
      (sourceIdentity === undefined ||
        previous.sourceIdentity === undefined ||
        previous.sourceIdentity === sourceIdentity)
    ) {
      previous.target = preparedTarget;
      previous.sourceIdentity ??= sourceIdentity;
      retainControlUiSessionPrBranchSnapshot(previous, retained);
      return previous;
    }
    previous?.cancelRefresh?.();
    previous?.cacheLifetime.abort(null);
    const state: WatchedKeyState = {
      connIds: new Set(previous?.connIds),
      sessionKeysByConnId: new Map(previous?.sessionKeysByConnId),
      target: preparedTarget,
      prepared: previous?.prepared,
      sourceIdentity,
      cacheLifetime: new AbortController(),
    };
    retainControlUiSessionPrBranchSnapshot(state, retained);
    keyStates.set(target.identity, state);
    return state;
  };

  const prepared = createControlUiSessionPrPreparedRead({
    scope,
    limit,
    withSource,
    load: loadSessionPullRequests,
    keyStates,
    stateForTarget,
    reads: deps.reads,
    getConfig: deps.getConfig,
  });

  const reconcileWatcher = (
    connId: string,
    sessionKey: string,
    watched: Watched | undefined,
    target: ControlUiSessionPrTarget | undefined,
  ) => {
    const subscription = subscriptions.get(connId);
    if (scope.isClosing || subscription?.get(sessionKey) !== watched) {
      return undefined;
    }
    if (!deps.reads.isViewerConnected(connId)) {
      unsubscribe(connId);
      return undefined;
    }
    if (!watched || !target) {
      if (watched?.target.ownGitHubProfileId && deps.reads.isViewerConnected(connId)) {
        deps.reads.invalidateViewer(connId);
      }
      subscription?.delete(sessionKey);
      removeMembership(watched && keyStates.get(watched.target.identity), connId, sessionKey);
      if (subscription?.size === 0) {
        // Pruning an old watch does not retire a newer replacement still preparing its keys.
        subscriptions.delete(connId);
        if (subscriptions.size === 0) {
          pollJob?.cancel();
          pollJob = undefined;
        }
      }
      return undefined;
    }
    if (watched.target.identity === target.identity) {
      watched.target = target;
      return target;
    }
    const previous = keyStates.get(watched.target.identity);
    const state = stateForTarget(target, undefined, previous);
    if (
      watched.target.ownGitHubIdentity &&
      watched.target.ownGitHubIdentity !== target.ownGitHubIdentity
    ) {
      deps.reads.invalidateViewer(connId);
    }
    removeMembership(previous, connId, sessionKey);
    watched.deliveredHash = undefined;
    watched.target = target;
    addControlUiSessionPrMembership(state, connId, sessionKey);
    const replacement = scope
      .track(() => loadSnapshot(target.identity))
      .then(
        () => undefined,
        () => undefined,
      );
    replacements.add(replacement);
    void replacement.finally(() => replacements.delete(replacement));
    return target;
  };

  const currentWatcher = (connId: string, sessionKey: string) => {
    const watched = subscriptions.get(connId)?.get(sessionKey);
    let target: ControlUiSessionPrTarget | undefined;
    if (watched && deps.reads.isViewerConnected(connId)) {
      try {
        watched.target.assertCurrent?.();
        target = watched.target.assertCurrent ? watched.target : undefined;
      } catch {
        // Only changed grants need queued preparation; current grants stay synchronous.
      }
      if (!target) {
        return limitReads(watched.readCurrent).then((current) =>
          reconcileWatcher(connId, sessionKey, watched, current),
        );
      }
    }
    return reconcileWatcher(connId, sessionKey, watched, target);
  };

  const currentKeyState = async (cacheKey: string) => {
    const state = keyStates.get(cacheKey);
    // Revalidate only this audience's requested spellings, not every key on each connection.
    for (const [connId, keys] of state?.sessionKeysByConnId ?? []) {
      for (const key of keys) {
        const current = currentWatcher(connId, key);
        if (current instanceof Promise) {
          await current;
        }
      }
    }
    return keyStates.get(cacheKey);
  };

  const loadSnapshot = async (
    cacheKey: string,
    refresh = false,
  ): Promise<ControlUiSessionPullRequestSnapshot> => {
    const targetState = await currentKeyState(cacheKey);
    if (scope.isClosing || !targetState?.connIds.size) {
      return UNAVAILABLE_SNAPSHOT;
    }
    return withSource(
      targetState.target,
      async (assertSourceCurrent, sourceIdentity, sourceScope, selectedRead) => {
        const state = stateForTarget(targetState.target, sourceIdentity);
        const pending = inflight.get(cacheKey);
        if (pending) {
          if (pending.state === state && (!refresh || pending.refresh)) {
            return pending.promise;
          }
          // Serialize a forced refresh behind an older normal load so that older
          // poll results can never land after the refresh and revert its snapshot.
          await pending.promise;
          assertSourceCurrent();
          return (await currentKeyState(cacheKey)) === state
            ? loadSnapshot(cacheKey, refresh)
            : UNAVAILABLE_SNAPSHOT;
        }
        const promise = scope
          .track(async () => {
            const delay = refresh
              ? (state.refreshedAt ?? -Infinity) +
                CONTROL_UI_SESSION_PR_REFRESH_INTERVAL_MS -
                scheduler.now()
              : 0;
            if (delay > 0) {
              // Retain the source before this wait, without occupying a loader slot.
              await new Promise<void>((resolve) => {
                const refreshJob = scheduler.schedule({
                  id: `control-ui-session-pr-refresh:${cacheKey}`,
                  delayMs: delay,
                  run: resolve,
                });
                state.cancelRefresh = () => {
                  refreshJob.cancel();
                  resolve();
                };
              });
              state.cancelRefresh = undefined;
            }
            return await limit(async () => {
              if ((await currentKeyState(cacheKey)) !== state || state.connIds.size === 0) {
                return UNAVAILABLE_SNAPSHOT;
              }
              if (refresh) {
                state.refreshedAt = scheduler.now();
              }
              const assertReadCurrent = () => {
                assertSourceCurrent();
                if (scope.isClosing || keyStates.get(state.target.identity) !== state) {
                  throw new Error("Session pull-request watchers changed");
                }
                // Shared work survives a departing viewer while another prepared reader
                // still authorizes this exact source. Delivery keeps its per-viewer guard.
                for (const [connId, keys] of state.sessionKeysByConnId) {
                  if (!deps.reads.isViewerConnected(connId)) {
                    continue;
                  }
                  for (const key of keys) {
                    const watched = subscriptions.get(connId)?.get(key);
                    if (!watched || watched.target.identity !== state.target.identity) {
                      continue;
                    }
                    try {
                      watched.target.assertCurrent?.();
                      return;
                    } catch {
                      // A different watcher may still own a current grant.
                    }
                  }
                }
                throw new Error("Session pull-request watchers changed");
              };
              let assertReadAuthority: (() => void) | undefined;
              const snapshot = await loadSessionPullRequests(
                { ...state.target.params, ...(refresh ? { refresh: true } : {}) },
                state.cacheLifetime.signal,
                {
                  target: selectedRead ? { ...state.target, read: selectedRead } : state.target,
                  sourceIdentity,
                  sourceScope,
                  readTaskPublications: selectedRead?.readTaskPublications,
                  branchSnapshot: state.branchSnapshot,
                  onBranchRead: (branch) => {
                    assertReadCurrent();
                    prepared.publishBranchSnapshot(state.target, pushedSnapshot(branch));
                  },
                  assertCurrent: assertReadCurrent,
                  retainReadAuthority: (guard) => {
                    assertReadAuthority = guard;
                  },
                },
              )
                .then(pushedSnapshot)
                .catch(() => ({ ...UNAVAILABLE_SNAPSHOT }));
              if ((await currentKeyState(cacheKey)) === state) {
                assertSourceCurrent();
                prepared.publishSnapshot(state, snapshot, assertReadAuthority);
                // Shared equality does not acknowledge recipients that missed publication.
                await push(new Set(state.connIds), state, snapshot, assertSourceCurrent, refresh);
                const stalePassiveKey = staleReceiptsOnlyCell(keyStates, state, snapshot);
                if (stalePassiveKey) {
                  void loadSnapshot(stalePassiveKey);
                }
              }
              return snapshot;
            });
          })
          .catch(() => UNAVAILABLE_SNAPSHOT)
          .finally(() => {
            if (inflight.get(cacheKey)?.promise === promise) {
              inflight.delete(cacheKey);
            }
          });
        inflight.set(cacheKey, {
          promise,
          refresh,
          state,
        });
        return promise;
      },
    ).catch(() => UNAVAILABLE_SNAPSHOT);
  };

  const push = (
    connIds: ReadonlySet<string>,
    state: WatchedKeyState,
    snapshot: ControlUiSessionPullRequestSnapshot,
    assertSourceCurrent: () => void,
    refresh = false,
    requestedKey?: string,
  ): Promise<void> => {
    if (connIds.size === 0 || (state.target.ownGitHubProfileId && state.snapshot !== snapshot)) {
      return Promise.resolve();
    }
    // Retain the authority for these facts across queued delivery and watcher reads.
    const assertReadAuthority = state.assertReadAuthority;
    const hash = JSON.stringify(snapshot);
    const isDelivered = (watched: Watched) =>
      !(refresh && watched.refreshPending) && watched.deliveredHash === hash;
    return enqueuePrDelivery(state, async () => {
      for (const connId of connIds) {
        const keys = requestedKey
          ? [requestedKey]
          : [...(state.sessionKeysByConnId.get(connId) ?? [])];
        for (const sessionKey of keys) {
          const watched = subscriptions.get(connId)?.get(sessionKey);
          if (!watched || isDelivered(watched)) {
            continue;
          }
          const current = await currentWatcher(connId, sessionKey);
          if (
            !current ||
            scope.isClosing ||
            current.identity !== state.target.identity ||
            subscriptions.get(connId)?.get(sessionKey) !== watched ||
            !deps.reads.isViewerConnected(connId) ||
            keyStates.get(state.target.identity) !== state ||
            isDelivered(watched)
          ) {
            continue;
          }
          assertSourceCurrent();
          try {
            // The shared cache can carry another viewer's target after preparation yields.
            current.assertCurrent?.();
            assertReadAuthority?.();
          } catch {
            if (current.ownGitHubProfileId) {
              if (state.snapshot === snapshot) {
                state.snapshot = undefined;
              }
              deps.reads.invalidateViewer(connId);
            }
            // Losing one recipient must not suppress the same snapshot for other viewers.
            continue;
          }
          const sessions = Object.create(null) as ControlUiSessionPullRequestsChanged["sessions"];
          sessions[sessionKey] = snapshot;
          recordSessionPrDiagnostic("broadcast", state.target);
          deps.reads.publishReviewUpdates(new Set([connId]), { sessions }, state.target.params);
          if (subscriptions.get(connId)?.get(sessionKey) === watched) {
            watched.deliveredHash = hash;
            if (refresh) {
              delete watched.refreshPending;
            }
          }
        }
      }
    });
  };

  const pollNow = (): Promise<void> => {
    if (scope.isClosing) {
      return Promise.resolve();
    }
    return scope.track(async () => {
      const loads = [];
      for (const [sessionKey, state] of keyStates) {
        if (state.connIds.size > 0) {
          loads.push(
            state.target.taskReceiptsOnly ? currentKeyState(sessionKey) : loadSnapshot(sessionKey),
          );
        }
      }
      await Promise.all([Promise.allSettled(replacements), prepared.settle(), ...loads]);
      await Promise.allSettled(replacements);
    });
  };

  const stopLineage = deps.reads.subscribeChanges((change) => {
    const ownAuthorityChanged = change.kind === "config";
    if (!ownAuthorityChanged && (change.kind !== "session" || !change.lineageChanged)) {
      return;
    }
    const keys: string[] = [];
    // Reconcile only indexed audiences; removed roots wait for their replacement's receipt.
    for (const [key, state] of keyStates) {
      if (ownAuthorityChanged && !state.target.ownGitHubProfileId) {
        continue;
      }
      const removedRoot =
        change.kind === "session" &&
        change.removed &&
        change.sessionKey === state.target.params.sessionKey;
      if (
        !removedRoot &&
        (state.target.includesTaskPublications || state.target.ownGitHubProfileId) &&
        state.connIds.size
      ) {
        keys.push(key);
      }
    }
    if (keys.length > 0) {
      void scope
        .track(async () => {
          await yieldSessionListWork();
          return Promise.allSettled(keys.map(currentKeyState));
        })
        .catch(() => {});
    }
  });

  const stopReceipts = deps.reads.subscribeChanges((change) => {
    if (change.kind !== "publications") {
      return;
    }
    for (const [key, state] of keyStates) {
      if (!state.target.includesTaskPublications) {
        continue;
      }
      state.snapshot = undefined;
      if (state.prepared) {
        deps.reads.invalidate(state.target.params);
      }
      if (state.connIds.size) {
        void scope
          .track(async () => {
            await inflight.get(key)?.promise;
            await loadSnapshot(key);
          })
          .catch(() => {});
      }
    }
  });

  const replace = (
    connId: string,
    sessionKeys: readonly string[],
    requestedRefreshSessionKeys: ReadonlySet<string> = new Set(),
    onAdmitted?: () => void,
    passiveSessionKeys: ReadonlySet<string> = new Set(),
  ) => {
    let admitted = false;
    const admit = () => {
      if (!admitted) {
        admitted = true;
        onAdmitted?.();
      }
    };
    let refreshSessionKeys = requestedRefreshSessionKeys;
    const activeKeys = new Set(sessionKeys);
    const watchedKeys = new Set([...activeKeys, ...passiveSessionKeys]);
    if (scope.isClosing) {
      admit();
      return Promise.resolve();
    }
    const normalizedConnId = connId.trim();
    if (!normalizedConnId || !deps.reads.isViewerConnected(normalizedConnId)) {
      unsubscribe(normalizedConnId);
      admit();
      return Promise.resolve();
    }
    // An acknowledged cold refresh still belongs to retained active keys until installation.
    const pendingRefresh = replacementGenerations.get(normalizedConnId)?.refreshSessionKeys;
    const generation: Replacement = {
      refreshSessionKeys: pendingRefresh?.size
        ? new Set([
            ...refreshSessionKeys,
            ...[...pendingRefresh].filter((key) => activeKeys.has(key)),
          ])
        : refreshSessionKeys,
    };
    replacementGenerations.set(normalizedConnId, generation);
    for (const key of watchedKeys) {
      const watched = subscriptions.get(normalizedConnId)?.get(key);
      if (watched && refreshSessionKeys.has(key)) {
        watched.refreshPending = true;
      }
    }
    admit();
    const replacement = scope.track(async () => {
      const previousSubscription = subscriptions.get(normalizedConnId);
      const subscription = new Map<string, Watched>();
      for (const key of watchedKeys) {
        const parsed = parseAgentSessionKey(key);
        const session =
          parsed?.rest === "global"
            ? { sessionKey: "global", agentId: parsed.agentId }
            : { sessionKey: key };
        const previous = previousSubscription?.get(key);
        const receiptOnly = !activeKeys.has(key);
        const existingMode = previous?.target.taskReceiptsOnly === true;
        let readCurrent = existingMode === receiptOnly ? previous?.readCurrent : undefined;
        let target = await readCurrent?.();
        if (!target) {
          const preparedRead = createControlUiSessionPrRead(
            deps.reads.createViewerRead(normalizedConnId, {
              ...session,
              allowOwnImportedPullRequest: true,
            }),
            deps.getConfig,
          );
          readCurrent =
            preparedRead && receiptOnly
              ? async () => {
                  const current = await preparedRead();
                  return (
                    current && {
                      ...current,
                      taskReceiptsOnly: true,
                      identity: JSON.stringify([current.identity, "receipts-only"]),
                    }
                  );
                }
              : preparedRead;
          target = await readCurrent?.();
        }
        if (!readCurrent || !target) {
          continue;
        }
        const next =
          previous?.target.identity === target.identity && readCurrent === previous.readCurrent
            ? previous
            : { readCurrent, target };
        if (next !== previous && generation.refreshSessionKeys?.has(key)) {
          next.refreshPending = true;
          // Retained cells already have their forced load; new cells inherit uninstalled intent.
          if (!refreshSessionKeys.has(key)) {
            refreshSessionKeys = new Set([...refreshSessionKeys, key]);
          }
        }
        subscription.set(key, next);
      }
      const currentReplacement =
        !scope.isClosing && replacementGenerations.get(normalizedConnId) === generation;
      if (!currentReplacement) {
        const current = subscriptions.get(normalizedConnId);
        for (const [key, watched] of subscription) {
          if (
            !refreshSessionKeys.has(key) ||
            current?.get(key) !== watched ||
            !watched.refreshPending
          ) {
            subscription.delete(key);
          }
        }
      }
      if (subscription.size === 0) {
        if (currentReplacement) {
          unsubscribe(normalizedConnId);
        }
        return;
      }
      if (currentReplacement) {
        subscriptions.set(normalizedConnId, subscription);
        generation.refreshSessionKeys = undefined;
        // Add before removing so an alias change retains its audience cell and cache lifetime.
        for (const [key, watched] of subscription) {
          const previous = previousSubscription?.get(key);
          const retained = previous && keyStates.get(previous.target.identity);
          addControlUiSessionPrMembership(
            stateForTarget(watched.target, undefined, retained),
            normalizedConnId,
            key,
          );
        }
        removeMemberships(normalizedConnId, previousSubscription, subscription);
        if (!pollJob) {
          pollJob = scheduler.schedule({
            id: "control-ui-session-pr-poll",
            atMs: scheduler.now() + CONTROL_UI_SESSION_PR_POLL_INTERVAL_MS,
            everyMs: CONTROL_UI_SESSION_PR_POLL_INTERVAL_MS,
            run: pollNow,
          });
        }
      }

      await Promise.all(
        Array.from(subscription, async ([sessionKey, watched]) => {
          const cacheKey = watched.target.identity;
          const targetState = await currentKeyState(cacheKey);
          if (!targetState) {
            return;
          }
          return withSource(targetState.target, async (assertSourceCurrent, sourceIdentity) => {
            const state = stateForTarget(targetState.target, sourceIdentity);
            const isCurrent = () =>
              subscriptions.get(normalizedConnId)?.get(sessionKey) === watched;
            const refresh = refreshSessionKeys.has(sessionKey);
            const cached = refresh ? undefined : state.snapshot;
            // A shared cached snapshot does not prove this connection received it.
            if (cached) {
              if (!watched.deliveredHash) {
                await push(
                  new Set([normalizedConnId]),
                  state,
                  cached,
                  assertSourceCurrent,
                  false,
                  sessionKey,
                );
              }
              return;
            }
            const snapshot = await loadSnapshot(cacheKey, refresh);
            assertSourceCurrent();
            // A removed/re-added key has a new cell; retained keys still need their result.
            if (isCurrent() && (refresh ? watched.refreshPending : !watched.deliveredHash)) {
              await push(
                new Set([normalizedConnId]),
                state,
                snapshot,
                assertSourceCurrent,
                refresh,
                sessionKey,
              );
            }
          }).catch(() => {});
        }),
      );
    });
    replacements.add(replacement);
    const releaseReplacement = () => {
      admit();
      replacements.delete(replacement);
      if (replacementGenerations.get(normalizedConnId) === generation) {
        replacementGenerations.delete(normalizedConnId);
      }
    };
    void replacement.then(releaseReplacement, releaseReplacement);
    return replacement;
  };

  const unsubscribe = (connId: string) => {
    const normalizedConnId = connId.trim();
    if (!normalizedConnId) {
      return;
    }
    replacementGenerations.delete(normalizedConnId);
    removeMemberships(normalizedConnId, subscriptions.get(normalizedConnId));
    subscriptions.delete(normalizedConnId);
    if (subscriptions.size === 0) {
      pollJob?.cancel();
      pollJob = undefined;
    }
  };

  const stop = (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }
    scope.beginClose();
    scheduler.beginClose();
    prepared.stop();
    stopReceipts();
    stopLineage();
    subscriptions.clear();
    replacementGenerations.clear();
    replacements.clear();
    for (const state of keyStates.values()) {
      state.cancelRefresh?.();
      state.cacheLifetime.abort(null);
    }
    keyStates.clear();
    stopPromise = Promise.all([scope.drain(), scheduler.stop()]).then(() => inflight.clear());
    return stopPromise;
  };

  return {
    read: prepared.read,
    readPrepared: prepared.readPrepared,
    replace,
    unsubscribe,
    pollNow,
    stop,
  };
}
