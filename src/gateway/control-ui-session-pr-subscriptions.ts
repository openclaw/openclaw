import pLimit from "p-limit";
import type { GatewayScheduler, GatewayScheduledJob } from "../infra/gateway-scheduler.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import type {
  ControlUiSessionPullRequestSnapshot,
  ControlUiSessionPullRequestsChanged,
} from "./control-ui-contract.js";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "./control-ui-contract.js";
import { enqueuePrDelivery, invalidatePrReader } from "./control-ui-session-pr-delivery.js";
import {
  createControlUiSessionPrPreparedRead,
  addControlUiSessionPrMembership,
  type PreparedSessionPrState,
  loadSessionPullRequests,
  pushedSnapshot,
  retainControlUiSessionPrBranchSnapshot,
  retireControlUiSessionPrState,
  UNAVAILABLE_SNAPSHOT,
} from "./control-ui-session-pr-prepared-read.js";
import type {
  ControlUiSessionPrRead,
  ControlUiSessionPrTarget,
} from "./control-ui-session-pr-read.js";
import { withControlUiSessionPrSource } from "./control-ui-session-pr-source.js";
import type { ControlUiSessionPullRequestsParams } from "./control-ui-session-prs.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { SessionRowProjection } from "./session-row-projection.js";

const CONTROL_UI_SESSION_PR_POLL_INTERVAL_MS = 60_000;
const CONTROL_UI_SESSION_PR_REFRESH_INTERVAL_MS = 10_000;
const CONTROL_UI_SESSION_PR_LOAD_CONCURRENCY = 4;

type WatchedKeyState = PreparedSessionPrState & {
  sessionKeysByConnId: Map<string, Set<string>>;
  refreshedAt?: number;
  cancelRefresh?: () => void;
  delivery?: Promise<void>;
};

type SubscriptionDeps = {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  prepareRead: (
    connId: string,
    session: Pick<ControlUiSessionPullRequestsParams, "sessionKey" | "agentId">,
  ) => Promise<ControlUiSessionPrRead | undefined>;
  isConnectionActive?: (connId: string) => boolean;
  scheduler: GatewayScheduler;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
};

export { parseControlUiSessionPullRequestsSubscribeParams } from "./control-ui-session-pr-subscription-params.js";

/**
 * Owns the union of connection replace-sets. Only this union drives GitHub
 * refreshes, so hidden/disconnected clients cannot leave orphan polling work.
 */
export function createControlUiSessionPullRequestSubscriptions(deps: SubscriptionDeps) {
  // A retained key keeps its work and delivery lifetime; removing it retires that cell.
  type Watched = {
    readCurrent: ControlUiSessionPrRead;
    target: ControlUiSessionPrTarget;
    deliveredHash?: string;
    refreshPending?: boolean;
  };
  const subscriptions = new Map<string, Map<string, Watched>>();
  const replacements = new Set<Promise<void>>();
  const replacementGenerations = new Map<string, object>();
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
  const withSource = <T>(
    target: ControlUiSessionPrTarget,
    operation: (assertCurrent: () => void, sourceIdentity: string) => Promise<T>,
  ) => withControlUiSessionPrSource(target.readSource, operation);
  let pollJob: GatewayScheduledJob | undefined;
  const scope = new AsyncWorkScope();
  let stopPromise: Promise<void> | undefined;

  const removeMembership = (
    state: WatchedKeyState | undefined,
    connId: string,
    sessionKey: string,
  ) => {
    const keys = state?.sessionKeysByConnId.get(connId);
    keys?.delete(sessionKey);
    if (keys?.size === 0) {
      state?.sessionKeysByConnId.delete(connId);
      state?.connIds.delete(connId);
    }
    retireControlUiSessionPrState(state, keyStates);
  };

  const removeMemberships = (
    connId: string,
    previous: ReadonlyMap<string, Watched> | undefined,
    retained?: ReadonlyMap<string, Watched>,
  ) => {
    for (const key of previous?.keys() ?? []) {
      const oldTarget = previous?.get(key)?.target;
      if (oldTarget && retained?.get(key)?.target.identity !== oldTarget.identity) {
        const state = keyStates.get(oldTarget.identity);
        removeMembership(state, connId, key);
      }
    }
  };

  const stateForTarget = (
    target: ControlUiSessionPrTarget,
    sourceIdentity?: string,
    retained?: WatchedKeyState,
  ) => {
    // Shared snapshots outlive individual viewers; authority stays only in each watched reader.
    const { assertCurrent: _assertCurrent, ...preparedTarget } = target;
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
    getSessionRowProjection: deps.getSessionRowProjection,
  });

  const currentWatcher = async (connId: string, sessionKey: string) => {
    const watched = subscriptions.get(connId)?.get(sessionKey);
    const target =
      deps.isConnectionActive?.(connId) === false
        ? undefined
        : await limitReads(() => watched?.readCurrent());
    const subscription = subscriptions.get(connId);
    if (scope.isClosing || subscription?.get(sessionKey) !== watched) {
      return undefined;
    }
    if (deps.isConnectionActive?.(connId) === false) {
      unsubscribe(connId);
      return undefined;
    }
    if (!watched || !target) {
      if (watched?.target.ownGitHubProfileId && deps.isConnectionActive?.(connId) !== false) {
        invalidatePrReader(connId, deps.broadcastToConnIds);
      }
      subscription?.delete(sessionKey);
      const state = watched && keyStates.get(watched.target.identity);
      removeMembership(state, connId, sessionKey);
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
    const changed = watched.target.identity !== target.identity;
    const previous = keyStates.get(watched.target.identity);
    const state = stateForTarget(target, undefined, previous);
    if (changed) {
      if (
        watched.target.ownGitHubIdentity &&
        watched.target.ownGitHubIdentity !== target.ownGitHubIdentity
      ) {
        invalidatePrReader(connId, deps.broadcastToConnIds);
      }
      removeMembership(previous, connId, sessionKey);
      watched.deliveredHash = undefined;
    }
    watched.target = target;
    addControlUiSessionPrMembership(state, connId, sessionKey);
    if (changed) {
      const replacement = scope
        .track(() => loadSnapshot(target.identity))
        .then(
          () => {},
          () => {},
        );
      replacements.add(replacement);
      void replacement.finally(() => replacements.delete(replacement));
    }
    return { watched, target };
  };

  const currentKeyState = async (cacheKey: string) => {
    const state = keyStates.get(cacheKey);
    // Revalidate only this audience's requested spellings, not every key on each connection.
    for (const [connId, keys] of state?.sessionKeysByConnId ?? []) {
      for (const key of keys) {
        await currentWatcher(connId, key);
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
    return withSource(targetState.target, async (assertSourceCurrent, sourceIdentity) => {
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
                if (deps.isConnectionActive?.(connId) === false) {
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
                target: state.target,
                sourceIdentity,
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
    }).catch(() => UNAVAILABLE_SNAPSHOT);
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
            current.watched !== watched ||
            current.target.identity !== state.target.identity ||
            subscriptions.get(connId)?.get(sessionKey) !== watched ||
            deps.isConnectionActive?.(connId) === false ||
            keyStates.get(state.target.identity) !== state ||
            isDelivered(watched)
          ) {
            continue;
          }
          assertSourceCurrent();
          try {
            // The shared cache can carry another viewer's target after preparation yields.
            current.target.assertCurrent?.();
            assertReadAuthority?.();
          } catch {
            if (current.target.ownGitHubProfileId) {
              if (state.snapshot === snapshot) {
                state.snapshot = undefined;
              }
              invalidatePrReader(connId, deps.broadcastToConnIds);
            }
            // Losing one recipient must not suppress the same snapshot for other viewers.
            continue;
          }
          const sessions = Object.create(null) as ControlUiSessionPullRequestsChanged["sessions"];
          sessions[sessionKey] = snapshot;
          // A socket callback can replace the session or retire another viewer synchronously.
          deps.broadcastToConnIds(
            CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
            { sessions },
            new Set([connId]),
            {
              sessionKeys: [state.target.params.sessionKey],
              agentId: state.target.params.agentId,
            },
          );
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

  const schedulePoll = () => {
    if (scope.isClosing || pollJob || subscriptions.size === 0) {
      return;
    }
    pollJob = scheduler.schedule({
      id: "control-ui-session-pr-poll",
      atMs: scheduler.now() + CONTROL_UI_SESSION_PR_POLL_INTERVAL_MS,
      everyMs: CONTROL_UI_SESSION_PR_POLL_INTERVAL_MS,
      run: pollNow,
    });
  };

  const pollNow = (): Promise<void> => {
    if (scope.isClosing) {
      return Promise.resolve();
    }
    return scope.track(async () => {
      // One union pass owns each key once; the loader retains its failure and
      // rate-limit cache, so the poller never creates a second quota policy.
      const loads = [];
      for (const [sessionKey, state] of keyStates) {
        if (state.connIds.size > 0) {
          loads.push(
            state.target.taskReceiptsOnly ? currentKeyState(sessionKey) : loadSnapshot(sessionKey),
          );
        }
      }
      await Promise.all([Promise.allSettled(replacements), prepared.settle(), ...loads]);
      // Revalidation can migrate an audience to a new cell during this pass.
      await Promise.allSettled(replacements);
    });
  };

  const stopLineage = sessionChanges.subscribeFacts((change) => {
    const ownAuthorityChanged =
      "all" in change &&
      (change.scope === "profiles" ||
        change.scope === "config" ||
        change.scope === "config-profiles");
    if (
      keyStates.size === 0 ||
      (!ownAuthorityChanged && !sessionChangeScopeAffectsStoredRows(change)) ||
      ("facts" in change && change.facts?.kind === "unchanged")
    ) {
      return;
    }
    // One notification owns the concurrent reads; each watcher still authorizes its audience.
    const keys: string[] = [];
    for (const [key, state] of keyStates) {
      // A removed root may be immediately replaced under the same key. The next
      // entry notification (or normal poll) reconciles that watch after replacement.
      const removedRoot =
        "sessionKey" in change &&
        change.sessionKey === state.target.params.sessionKey &&
        change.facts?.kind === "removed";
      if (
        !removedRoot &&
        (!ownAuthorityChanged || state.target.ownGitHubProfileId) &&
        (state.target.taskReceipts || state.target.ownGitHubProfileId) &&
        state.connIds.size
      ) {
        keys.push(key);
      }
    }
    if (keys.length > 0) {
      void scope.track(() => Promise.allSettled(keys.map(currentKeyState))).catch(() => {});
    }
  });

  const stopReceipts = githubPublicationReceipts.subscribeFacts((change) => {
    if (change.kind !== "committed" && change.kind !== "unknown") {
      return;
    }
    // Commit events refresh the existing watched union; no child poller is created.
    for (const [key, state] of keyStates) {
      if (!state.target.taskReceipts) {
        continue;
      }
      state.snapshot = undefined;
      if (state.prepared) {
        sessionChanges.emit({ ...state.target.params, scope: "runtime" });
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
    refreshSessionKeys: ReadonlySet<string> = new Set(),
    onAdmitted?: () => void,
    passiveSessionKeys: ReadonlySet<string> = new Set(),
  ) => {
    const activeKeys = new Set(sessionKeys);
    const watchedKeys = [
      ...activeKeys,
      ...[...passiveSessionKeys].filter((key) => !activeKeys.has(key)),
    ];
    let admitted = false;
    const admit = () => {
      if (!admitted) {
        admitted = true;
        onAdmitted?.();
      }
    };
    if (scope.isClosing) {
      admit();
      return Promise.resolve();
    }
    const normalizedConnId = connId.trim();
    if (!normalizedConnId || deps.isConnectionActive?.(normalizedConnId) === false) {
      unsubscribe(normalizedConnId);
      admit();
      return Promise.resolve();
    }
    const generation = {};
    replacementGenerations.set(normalizedConnId, generation);
    for (const key of watchedKeys) {
      const watched = subscriptions.get(normalizedConnId)?.get(key);
      if (watched && refreshSessionKeys.has(key)) {
        watched.refreshPending = true;
      }
    }
    const isCurrentReplacement = () =>
      !scope.isClosing && replacementGenerations.get(normalizedConnId) === generation;
    const replacement = scope.track(async () => {
      try {
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
            const preparedRead = await deps.prepareRead(normalizedConnId, session);
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
          if (next !== previous && refreshSessionKeys.has(key)) {
            next.refreshPending = true;
          }
          subscription.set(key, next);
        }
        const currentReplacement = isCurrentReplacement();
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
          admit();
          return;
        }
        if (currentReplacement) {
          subscriptions.set(normalizedConnId, subscription);
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
          schedulePoll();
        }
        admit();

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
      } finally {
        admit();
      }
    });
    replacements.add(replacement);
    const releaseReplacement = () => {
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
    stopPromise = Promise.all([scope.drain(), scheduler.stop()]).then(() => {
      inflight.clear();
    });
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
