import pLimit from "p-limit";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/primitives.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import type {
  ControlUiSessionPullRequestSnapshot,
  ControlUiSessionPullRequests,
  ControlUiSessionPullRequestsChanged,
} from "./control-ui-contract.js";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS,
} from "./control-ui-contract.js";
import type {
  ControlUiSessionPrRead,
  ControlUiSessionPrReadContext,
  ControlUiSessionPrTarget,
} from "./control-ui-session-pr-read.js";
import { withControlUiSessionPrSource } from "./control-ui-session-pr-source.js";
import type { ControlUiSessionPullRequestsParams } from "./control-ui-session-prs.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";

const CONTROL_UI_SESSION_PR_POLL_INTERVAL_MS = 60_000;
const CONTROL_UI_SESSION_PR_REFRESH_INTERVAL_MS = 10_000;
const CONTROL_UI_SESSION_PR_LOAD_CONCURRENCY = 4;

type LoadSessionPullRequests = (
  params: ControlUiSessionPullRequestsParams,
  cacheSignal: AbortSignal | undefined,
  read: ControlUiSessionPrReadContext,
) => Promise<ControlUiSessionPullRequests>;

type WatchedKeyState = {
  connIds: Set<string>;
  target: ControlUiSessionPrTarget;
  watchLifetime: object;
  sourceIdentity?: string;
  // Retire cache pins with the shared key, without cancelling another watcher's load.
  cacheLifetime: AbortController;
  snapshot?: ControlUiSessionPullRequestSnapshot;
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
  load?: LoadSessionPullRequests;
  setTimer?: typeof globalThis.setTimeout;
  clearTimer?: typeof globalThis.clearTimeout;
};

type ControlUiSessionPullRequestSubscriptions = {
  replace: (
    connId: string,
    sessionKeys: readonly string[],
    refreshSessionKeys?: ReadonlySet<string>,
    onAdmitted?: () => void,
  ) => Promise<void>;
  unsubscribe: (connId: string) => void;
  pollNow: () => Promise<void>;
  stop: () => Promise<void>;
};

async function loadSessionPullRequests(
  params: ControlUiSessionPullRequestsParams,
  cacheSignal: AbortSignal | undefined,
  read: ControlUiSessionPrReadContext,
): Promise<ControlUiSessionPullRequests> {
  read.assertCurrent();
  const { loadControlUiSessionPullRequests } = await import("./control-ui-session-prs.js");
  return loadControlUiSessionPullRequests(params, { cacheSignal, read });
}

function pushedSnapshot(result: ControlUiSessionPullRequests): ControlUiSessionPullRequestSnapshot {
  return {
    ...result,
    status: result.status ?? (result.rateLimited ? "rate-limited" : "ready"),
  };
}

const UNAVAILABLE_SNAPSHOT: ControlUiSessionPullRequestSnapshot = {
  pullRequests: [],
  rateLimited: false,
  status: "unavailable",
};

function parseSessionKeys(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS) {
    return null;
  }
  const keys = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    const key = entry.trim();
    if (!key || key.length > CHAT_SEND_SESSION_KEY_MAX_LENGTH) {
      return null;
    }
    keys.add(key);
  }
  return [...keys];
}

export function parseControlUiSessionPullRequestsSubscribeParams(
  value: unknown,
): { sessionKeys: string[]; refreshSessionKeys: string[] } | null {
  if (!value || typeof value !== "object" || !("sessionKeys" in value)) {
    return null;
  }
  const raw = value as { sessionKeys?: unknown; refreshSessionKeys?: unknown };
  const sessionKeys = parseSessionKeys(raw.sessionKeys);
  const refreshSessionKeys =
    raw.refreshSessionKeys === undefined ? [] : parseSessionKeys(raw.refreshSessionKeys);
  if (!sessionKeys || !refreshSessionKeys) {
    return null;
  }
  const watched = new Set(sessionKeys);
  for (const key of refreshSessionKeys) {
    if (!watched.has(key)) {
      return null;
    }
  }
  return { sessionKeys, refreshSessionKeys };
}

/**
 * Owns the union of connection replace-sets. Only this union drives GitHub
 * refreshes, so hidden/disconnected clients cannot leave orphan polling work.
 */
export function createControlUiSessionPullRequestSubscriptions(
  deps: SubscriptionDeps,
): ControlUiSessionPullRequestSubscriptions {
  // A retained key keeps its work and delivery lifetime; removing it retires that cell.
  type Watched = {
    readCurrent: ControlUiSessionPrRead;
    target: ControlUiSessionPrTarget;
    deliveredHash?: string;
    delivery?: Promise<void>;
    refreshPending?: object;
  };
  const subscriptions = new Map<string, Map<string, Watched>>();
  const replacements = new Set<Promise<void>>();
  const replacementGenerations = new Map<string, object>();
  const pendingAdmissions = new Map<string, Set<() => boolean>>();
  const keyStates = new Map<string, WatchedKeyState>();
  const inflight = new Map<
    string,
    {
      promise: Promise<ControlUiSessionPullRequestSnapshot>;
      refresh: boolean;
      refreshRequests: Map<Watched, object>;
      state: WatchedKeyState;
      demands: Set<() => boolean>;
    }
  >();
  const setTimer = deps.setTimer ?? globalThis.setTimeout;
  const clearTimer = deps.clearTimer ?? globalThis.clearTimeout;
  const limit = pLimit(CONTROL_UI_SESSION_PR_LOAD_CONCURRENCY);
  const customLoad = deps.load;
  const load = customLoad ?? loadSessionPullRequests;
  const withSource = <T>(
    target: ControlUiSessionPrTarget,
    operation: (assertCurrent: () => void, sourceIdentity: string) => Promise<T>,
  ) =>
    customLoad
      ? operation(() => {}, target.identity)
      : withControlUiSessionPrSource(target.readSource, operation);
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  const scope = new AsyncWorkScope();
  let stopPromise: Promise<void> | undefined;

  const retireKeyStateIfUnused = (sessionKey: string, state: WatchedKeyState | undefined) => {
    if (
      !state ||
      state.connIds.size > 0 ||
      [...(pendingAdmissions.get(sessionKey) ?? [])].some((isCurrent) => isCurrent())
    ) {
      return;
    }
    state.cancelRefresh?.();
    state.cacheLifetime.abort(null);
    if (keyStates.get(sessionKey) === state) {
      keyStates.delete(sessionKey);
    }
  };

  const removeMemberships = (
    connId: string,
    previous: ReadonlyMap<string, unknown> | undefined,
    retained?: ReadonlyMap<string, unknown>,
  ) => {
    for (const key of previous?.keys() ?? []) {
      if (!retained?.has(key)) {
        const state = keyStates.get(key);
        state?.connIds.delete(connId);
        retireKeyStateIfUnused(key, state);
      }
    }
  };

  const stateForTarget = (
    sessionKey: string,
    target: ControlUiSessionPrTarget,
    sourceIdentity?: string,
  ) => {
    const previous = keyStates.get(sessionKey);
    if (
      previous?.target.identity === target.identity &&
      (sourceIdentity === undefined ||
        previous.sourceIdentity === undefined ||
        previous.sourceIdentity === sourceIdentity)
    ) {
      previous.target = target;
      previous.sourceIdentity ??= sourceIdentity;
      return previous;
    }
    previous?.cancelRefresh?.();
    previous?.cacheLifetime.abort(null);
    const state: WatchedKeyState = {
      connIds: new Set(previous?.connIds),
      target,
      watchLifetime: previous?.watchLifetime ?? {},
      sourceIdentity,
      cacheLifetime: new AbortController(),
    };
    keyStates.set(sessionKey, state);
    return state;
  };

  const currentWatcher = async (connId: string, sessionKey: string) => {
    const watched = subscriptions.get(connId)?.get(sessionKey);
    const target =
      deps.isConnectionActive?.(connId) === false ? undefined : await watched?.readCurrent();
    const subscription = subscriptions.get(connId);
    if (scope.isClosing || subscription?.get(sessionKey) !== watched) {
      return undefined;
    }
    if (!watched || !target || deps.isConnectionActive?.(connId) === false) {
      subscription?.delete(sessionKey);
      const state = keyStates.get(sessionKey);
      state?.connIds.delete(connId);
      retireKeyStateIfUnused(sessionKey, state);
      if (subscription?.size === 0) {
        // Pruning an old watch does not retire a newer replacement still preparing its keys.
        subscriptions.delete(connId);
        if (deps.isConnectionActive?.(connId) === false) {
          replacementGenerations.delete(connId);
        }
        if (subscriptions.size === 0 && timer !== null) {
          clearTimer(timer);
          timer = null;
        }
      }
      return undefined;
    }
    if (watched.target.identity !== target.identity) {
      watched.deliveredHash = undefined;
    }
    watched.target = target;
    stateForTarget(sessionKey, target).connIds.add(connId);
    return { watched, target };
  };

  const currentKeyState = async (sessionKey: string) => {
    for (const connId of keyStates.get(sessionKey)?.connIds ?? []) {
      await currentWatcher(connId, sessionKey);
    }
    return keyStates.get(sessionKey);
  };

  const loadSnapshot = async (
    sessionKey: string,
    isCurrent: () => boolean,
    refresh?: { watched: Watched; generation: object },
  ): Promise<ControlUiSessionPullRequestSnapshot> => {
    const targetState = await currentKeyState(sessionKey);
    if (scope.isClosing || !targetState || !isCurrent()) {
      return UNAVAILABLE_SNAPSHOT;
    }
    return withSource(targetState.target, async (assertSourceCurrent, sourceIdentity) => {
      const state = stateForTarget(sessionKey, targetState.target, sourceIdentity);
      const pending = inflight.get(sessionKey);
      if (pending) {
        if (pending.state === state && (!refresh || pending.refresh)) {
          pending.demands.add(isCurrent);
          if (refresh && refresh.watched.refreshPending === refresh.generation) {
            pending.refreshRequests.set(refresh.watched, refresh.generation);
          }
          return pending.promise;
        }
        // Serialize a forced refresh behind an older normal load so that older
        // poll results can never land after the refresh and revert its snapshot.
        await pending.promise;
        assertSourceCurrent();
        return (await currentKeyState(sessionKey)) === state && isCurrent()
          ? loadSnapshot(sessionKey, isCurrent, refresh)
          : UNAVAILABLE_SNAPSHOT;
      }
      const demands = new Set([isCurrent]);
      const refreshRequests = new Map<Watched, object>();
      if (refresh && refresh.watched.refreshPending === refresh.generation) {
        refreshRequests.set(refresh.watched, refresh.generation);
      }
      const promise = scope
        .track(async () => {
          const delay = refresh
            ? (state.refreshedAt ?? -Infinity) +
              CONTROL_UI_SESSION_PR_REFRESH_INTERVAL_MS -
              Date.now()
            : 0;
          if (delay > 0) {
            // Retain the source before this wait, without occupying a loader slot.
            await new Promise<void>((resolve) => {
              const refreshTimer = setTimer(resolve, delay);
              refreshTimer.unref?.();
              state.cancelRefresh = () => {
                clearTimer(refreshTimer);
                resolve();
              };
            });
            state.cancelRefresh = undefined;
          }
          return await limit(async () => {
            // Joiners retain their own watched-key lifetimes. A later force-only
            // watcher must not revive normal work retired while waiting for a slot.
            if (
              !Array.from(demands).some((current) => current()) ||
              (await currentKeyState(sessionKey)) !== state
            ) {
              return UNAVAILABLE_SNAPSHOT;
            }
            if (refresh) {
              state.refreshedAt = Date.now();
            }
            const snapshot = await load(
              { ...state.target.params, ...(refresh ? { refresh: true } : {}) },
              state.cacheLifetime.signal,
              {
                target: state.target,
                sourceIdentity,
                assertCurrent: () => {
                  assertSourceCurrent();
                  if (
                    scope.isClosing ||
                    !Array.from(demands).some((current) => current()) ||
                    keyStates.get(sessionKey) !== state
                  ) {
                    throw new Error("Session pull-request watchers changed");
                  }
                  // Shared work survives a departing viewer while another prepared reader
                  // still authorizes this exact source. Delivery keeps its per-viewer guard.
                  for (const connId of state.connIds) {
                    const watched = subscriptions.get(connId)?.get(sessionKey);
                    if (
                      !watched ||
                      watched.target.identity !== state.target.identity ||
                      deps.isConnectionActive?.(connId) === false
                    ) {
                      continue;
                    }
                    try {
                      watched.target.assertCurrent?.();
                      return;
                    } catch {
                      // A different watcher may still own a current grant.
                    }
                  }
                  throw new Error("Session pull-request watchers changed");
                },
              },
            )
              .then(pushedSnapshot)
              .catch(() => ({ ...UNAVAILABLE_SNAPSHOT }));
            if ((await currentKeyState(sessionKey)) === state) {
              assertSourceCurrent();
              state.snapshot = snapshot;
              // Shared equality does not acknowledge recipients that missed publication.
              await push(
                new Set(state.connIds),
                sessionKey,
                state,
                snapshot,
                assertSourceCurrent,
                refreshRequests,
              );
            }
            return snapshot;
          });
        })
        .catch(() => UNAVAILABLE_SNAPSHOT)
        .finally(() => {
          if (inflight.get(sessionKey)?.promise === promise) {
            inflight.delete(sessionKey);
          }
        });
      inflight.set(sessionKey, {
        promise,
        refresh: Boolean(refresh),
        refreshRequests,
        state,
        demands,
      });
      return promise;
    }).catch(() => UNAVAILABLE_SNAPSHOT);
  };

  const push = (
    connIds: ReadonlySet<string>,
    sessionKey: string,
    state: WatchedKeyState,
    snapshot: ControlUiSessionPullRequestSnapshot,
    assertSourceCurrent: () => void,
    refreshRequests?: ReadonlyMap<Watched, object>,
  ): Promise<void> => {
    if (connIds.size === 0) {
      return Promise.resolve();
    }
    const hash = JSON.stringify(snapshot);
    // Equal data acknowledges only the exact refresh requests joined by this load.
    const isDelivered = (watched: Watched) => {
      const request = refreshRequests?.get(watched);
      return (!request || watched.refreshPending !== request) && watched.deliveredHash === hash;
    };
    const previousStateDelivery = state.delivery ?? Promise.resolve();
    const stateDelivery = previousStateDelivery
      .then(async () => {
        const sessions = Object.create(null) as ControlUiSessionPullRequestsChanged["sessions"];
        sessions[sessionKey] = snapshot;
        for (const connId of connIds) {
          const watched = subscriptions.get(connId)?.get(sessionKey);
          if (!watched || isDelivered(watched)) {
            continue;
          }
          const previous = watched.delivery ?? Promise.resolve();
          const delivery = previous
            .then(async () => {
              const current = await currentWatcher(connId, sessionKey);
              if (
                !current ||
                scope.isClosing ||
                current.watched !== watched ||
                subscriptions.get(connId)?.get(sessionKey) !== watched ||
                deps.isConnectionActive?.(connId) === false ||
                keyStates.get(sessionKey) !== state ||
                isDelivered(watched)
              ) {
                return;
              }
              assertSourceCurrent();
              try {
                // The shared cache can carry another viewer's target after preparation yields.
                current.target.assertCurrent?.();
              } catch {
                // Losing one recipient must not suppress the same snapshot for other viewers.
                return;
              }
              const refreshRequest = refreshRequests?.get(watched);
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
                if (refreshRequest && watched.refreshPending === refreshRequest) {
                  delete watched.refreshPending;
                }
              }
            })
            .finally(() => {
              if (watched.delivery === delivery) {
                delete watched.delivery;
              }
            });
          watched.delivery = delivery;
          await delivery;
        }
      })
      .finally(() => {
        if (state.delivery === stateDelivery) {
          delete state.delivery;
        }
      });
    state.delivery = stateDelivery;
    return stateDelivery;
  };

  const schedulePoll = () => {
    if (scope.isClosing || timer !== null || subscriptions.size === 0) {
      return;
    }
    timer = setTimer(() => {
      timer = null;
      void pollNow().finally(schedulePoll);
    }, CONTROL_UI_SESSION_PR_POLL_INTERVAL_MS);
    timer.unref?.();
  };

  const pollNow = (): Promise<void> => {
    if (scope.isClosing) {
      return Promise.resolve();
    }
    return scope.track(async () => {
      // One union pass owns each key once; the loader retains its failure and
      // rate-limit cache, so the poller never creates a second quota policy.
      await Promise.all([
        Promise.allSettled(replacements),
        Promise.all(
          Array.from(keyStates, ([sessionKey, state]) => {
            const watchLifetime = state.watchLifetime;
            return loadSnapshot(
              sessionKey,
              () => keyStates.get(sessionKey)?.watchLifetime === watchLifetime,
            );
          }),
        ),
      ]);
    });
  };

  const replace = (
    connId: string,
    sessionKeys: readonly string[],
    refreshSessionKeys: ReadonlySet<string> = new Set(),
    onAdmitted?: () => void,
  ) => {
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
    // A fresh identity cannot revive retired work when a connection ID is reused.
    const generation = {};
    replacementGenerations.set(normalizedConnId, generation);
    // Reserve retained-key intent in call order; an older preparation cannot overwrite it later.
    for (const key of sessionKeys) {
      const watched = subscriptions.get(normalizedConnId)?.get(key);
      if (watched && refreshSessionKeys.has(key)) {
        watched.refreshPending = generation;
      }
    }
    const isCurrentReplacement = () =>
      !scope.isClosing && replacementGenerations.get(normalizedConnId) === generation;
    const replacement = scope.track(async () => {
      const retainedKeys = new Set(sessionKeys.filter((key) => keyStates.has(key)));
      for (const key of retainedKeys) {
        const admissions = pendingAdmissions.get(key) ?? new Set<() => boolean>();
        admissions.add(isCurrentReplacement);
        pendingAdmissions.set(key, admissions);
      }
      try {
        const previousSubscription = subscriptions.get(normalizedConnId);
        const subscription = new Map<string, Watched>();
        for (const key of sessionKeys) {
          const parsed = parseAgentSessionKey(key);
          const session =
            parsed?.rest === "global"
              ? { sessionKey: "global", agentId: parsed.agentId }
              : { sessionKey: key };
          const previous = previousSubscription?.get(key);
          const readCurrent =
            previous && (await previous.readCurrent())
              ? previous.readCurrent
              : await deps.prepareRead(normalizedConnId, session);
          const target = await readCurrent?.();
          if (!readCurrent || !target) {
            continue;
          }
          const next =
            previous?.target.identity === target.identity && readCurrent === previous.readCurrent
              ? previous
              : { readCurrent, target };
          if (next !== previous && refreshSessionKeys.has(key)) {
            next.refreshPending = generation;
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
              watched.refreshPending !== generation
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
          removeMemberships(normalizedConnId, previousSubscription, subscription);
          // Publish the whole replacement before cached hydration can send synchronously.
          for (const [key, watched] of subscription) {
            stateForTarget(key, watched.target).connIds.add(normalizedConnId);
          }
          schedulePoll();
        }
        admit();

        await Promise.all(
          Array.from(subscription, async ([sessionKey, watched]) => {
            const targetState = await currentKeyState(sessionKey);
            if (!targetState) {
              return;
            }
            return withSource(targetState.target, async (assertSourceCurrent, sourceIdentity) => {
              const state = stateForTarget(sessionKey, targetState.target, sourceIdentity);
              const isCurrent = () =>
                subscriptions.get(normalizedConnId)?.get(sessionKey) === watched;
              const refresh = refreshSessionKeys.has(sessionKey);
              const cached = refresh ? undefined : state.snapshot;
              // A shared cached snapshot does not prove this connection received it.
              if (cached) {
                if (!watched.deliveredHash) {
                  await push(
                    new Set([normalizedConnId]),
                    sessionKey,
                    state,
                    cached,
                    assertSourceCurrent,
                  );
                }
                return;
              }
              const snapshot = await loadSnapshot(
                sessionKey,
                isCurrent,
                refresh ? { watched, generation } : undefined,
              );
              assertSourceCurrent();
              // A removed/re-added key has a new cell; retained keys still need their result.
              if (
                isCurrent() &&
                (refresh ? watched.refreshPending === generation : !watched.deliveredHash)
              ) {
                await push(
                  new Set([normalizedConnId]),
                  sessionKey,
                  state,
                  snapshot,
                  assertSourceCurrent,
                  refresh ? new Map([[watched, generation]]) : undefined,
                );
              }
            }).catch(() => {});
          }),
        );
      } finally {
        admit();
        for (const key of retainedKeys) {
          const admissions = pendingAdmissions.get(key);
          admissions?.delete(isCurrentReplacement);
          if (admissions?.size === 0) {
            pendingAdmissions.delete(key);
          }
          retireKeyStateIfUnused(key, keyStates.get(key));
        }
      }
    });
    replacements.add(replacement);
    void replacement.then(
      () => replacements.delete(replacement),
      () => replacements.delete(replacement),
    );
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
    if (subscriptions.size === 0 && timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const stop = (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }
    scope.beginClose();
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    subscriptions.clear();
    replacementGenerations.clear();
    replacements.clear();
    for (const state of keyStates.values()) {
      state.cancelRefresh?.();
      state.cacheLifetime.abort(null);
    }
    keyStates.clear();
    stopPromise = scope.drain().then(() => {
      inflight.clear();
    });
    return stopPromise;
  };

  return { replace, unsubscribe, pollNow, stop };
}
