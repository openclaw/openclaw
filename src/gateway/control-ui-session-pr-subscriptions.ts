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
  sourceIdentity?: string;
  // Retire cache pins with the shared key, without cancelling another watcher's load.
  cacheLifetime: AbortController;
  hash?: string;
  snapshot?: ControlUiSessionPullRequestSnapshot;
  refreshedAt?: number;
  cancelRefresh?: () => void;
};

type SubscriptionDeps = {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  prepareRead: (
    connId: string,
    session: Pick<ControlUiSessionPullRequestsParams, "sessionKey" | "agentId">,
  ) => ControlUiSessionPrRead | undefined;
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
    delivered?: ControlUiSessionPullRequestSnapshot;
  };
  const subscriptions = new Map<string, Map<string, Watched>>();
  const keyStates = new Map<string, WatchedKeyState>();
  const inflight = new Map<
    string,
    {
      promise: Promise<ControlUiSessionPullRequestSnapshot>;
      refresh: boolean;
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

  const removeMemberships = (
    connId: string,
    previous: ReadonlyMap<string, unknown> | undefined,
    retained?: ReadonlyMap<string, unknown>,
  ) => {
    for (const key of previous?.keys() ?? []) {
      if (!retained?.has(key)) {
        const state = keyStates.get(key);
        state?.connIds.delete(connId);
        if (state?.connIds.size === 0) {
          state.cancelRefresh?.();
          state.cacheLifetime.abort(null);
          keyStates.delete(key);
        }
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
      previous.sourceIdentity ??= sourceIdentity;
      return previous;
    }
    previous?.cancelRefresh?.();
    previous?.cacheLifetime.abort(null);
    const state: WatchedKeyState = {
      connIds: new Set(previous?.connIds),
      target,
      sourceIdentity,
      cacheLifetime: new AbortController(),
    };
    keyStates.set(sessionKey, state);
    return state;
  };

  const currentWatcher = (connId: string, sessionKey: string) => {
    const subscription = subscriptions.get(connId);
    const watched = subscription?.get(sessionKey);
    const target = deps.isConnectionActive?.(connId) === false ? undefined : watched?.readCurrent();
    if (!watched || !target) {
      subscription?.delete(sessionKey);
      const state = keyStates.get(sessionKey);
      state?.connIds.delete(connId);
      if (state?.connIds.size === 0) {
        state.cancelRefresh?.();
        state.cacheLifetime.abort(null);
        keyStates.delete(sessionKey);
      }
      if (subscription?.size === 0) {
        unsubscribe(connId);
      }
      return undefined;
    }
    if (watched.target.identity !== target.identity) {
      watched.target = target;
      watched.delivered = undefined;
    }
    stateForTarget(sessionKey, target).connIds.add(connId);
    return watched;
  };

  const currentKeyState = (sessionKey: string) => {
    for (const connId of keyStates.get(sessionKey)?.connIds ?? []) {
      currentWatcher(connId, sessionKey);
    }
    return keyStates.get(sessionKey);
  };

  const loadSnapshot = (
    sessionKey: string,
    isCurrent: () => boolean,
    refresh = false,
  ): Promise<ControlUiSessionPullRequestSnapshot> => {
    const targetState = currentKeyState(sessionKey);
    if (scope.isClosing || !targetState || !isCurrent()) {
      return Promise.resolve(UNAVAILABLE_SNAPSHOT);
    }
    return withSource(targetState.target, async (assertSourceCurrent, sourceIdentity) => {
      const state = stateForTarget(sessionKey, targetState.target, sourceIdentity);
      const pending = inflight.get(sessionKey);
      if (pending) {
        if (pending.state === state && (!refresh || pending.refresh)) {
          pending.demands.add(isCurrent);
          return pending.promise;
        }
        // Serialize a forced refresh behind an older normal load so that older
        // poll results can never land after the refresh and revert its snapshot.
        await pending.promise;
        assertSourceCurrent();
        return currentKeyState(sessionKey) === state && isCurrent()
          ? loadSnapshot(sessionKey, isCurrent, refresh)
          : UNAVAILABLE_SNAPSHOT;
      }
      const demands = new Set([isCurrent]);
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
              currentKeyState(sessionKey) !== state
            ) {
              return UNAVAILABLE_SNAPSHOT;
            }
            if (refresh) {
              state.refreshedAt = Date.now();
            }
            // Fresh result identity acknowledges forced loads even when the failure is unchanged.
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
                    currentKeyState(sessionKey) !== state
                  ) {
                    throw new Error("Session pull-request watchers changed");
                  }
                },
              },
            )
              .then(pushedSnapshot)
              .catch(() => ({ ...UNAVAILABLE_SNAPSHOT }));
            if (currentKeyState(sessionKey) === state) {
              assertSourceCurrent();
              const hash = JSON.stringify(snapshot);
              const changed = state.hash !== hash;
              Object.assign(state, { hash, snapshot });
              // Publish once at the shared owner, using the latest snapshot and watcher union.
              if (changed) {
                // A send can synchronously retire a watcher; delivery acknowledges this snapshot only.
                push(new Set(state.connIds), sessionKey, state, snapshot, assertSourceCurrent);
              }
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
      inflight.set(sessionKey, { promise, refresh, state, demands });
      return promise;
    }).catch(() => UNAVAILABLE_SNAPSHOT);
  };

  const push = (
    connIds: ReadonlySet<string>,
    sessionKey: string,
    state: WatchedKeyState,
    snapshot: ControlUiSessionPullRequestSnapshot,
    assertSourceCurrent: () => void,
  ) => {
    if (connIds.size === 0) {
      return;
    }
    const sessions = Object.create(null) as ControlUiSessionPullRequestsChanged["sessions"];
    sessions[sessionKey] = snapshot;
    for (const connId of connIds) {
      const watched = currentWatcher(connId, sessionKey);
      if (!watched || keyStates.get(sessionKey) !== state) {
        continue;
      }
      assertSourceCurrent();
      // A socket callback can replace the session or retire another viewer synchronously.
      deps.broadcastToConnIds(
        CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
        { sessions },
        new Set([connId]),
        { sessionKeys: [state.target.params.sessionKey], agentId: state.target.params.agentId },
      );
      if (subscriptions.get(connId)?.get(sessionKey) === watched) {
        watched.delivered = snapshot;
      }
    }
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
      await Promise.all(
        Array.from(keyStates.keys(), (sessionKey) =>
          loadSnapshot(sessionKey, () => keyStates.has(sessionKey)),
        ),
      );
    });
  };

  const replace = (
    connId: string,
    sessionKeys: readonly string[],
    refreshSessionKeys: ReadonlySet<string> = new Set(),
  ) => {
    if (scope.isClosing) {
      return Promise.resolve();
    }
    return scope.track(async () => {
      const normalizedConnId = connId.trim();
      if (!normalizedConnId || deps.isConnectionActive?.(normalizedConnId) === false) {
        return;
      }
      const previousSubscription = subscriptions.get(normalizedConnId);
      const subscription = new Map<string, Watched>();
      for (const key of sessionKeys) {
        const parsed = parseAgentSessionKey(key);
        const session =
          parsed?.rest === "global"
            ? { sessionKey: "global", agentId: parsed.agentId }
            : { sessionKey: key };
        const previous = previousSubscription?.get(key);
        const readCurrent = previous?.readCurrent()
          ? previous.readCurrent
          : deps.prepareRead(normalizedConnId, session);
        const target = readCurrent?.();
        if (!readCurrent || !target) {
          continue;
        }
        subscription.set(
          key,
          previous?.target.identity === target.identity && readCurrent === previous.readCurrent
            ? previous
            : { readCurrent, target },
        );
      }
      if (subscription.size === 0) {
        unsubscribe(normalizedConnId);
        return;
      }
      subscriptions.set(normalizedConnId, subscription);
      removeMemberships(normalizedConnId, previousSubscription, subscription);
      // Publish the whole replacement before cached hydration can send synchronously.
      for (const [key, watched] of subscription) {
        stateForTarget(key, watched.target).connIds.add(normalizedConnId);
      }
      schedulePoll();

      await Promise.all(
        Array.from(subscription, async ([sessionKey, watched]) => {
          const targetState = currentKeyState(sessionKey);
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
              if (!watched.delivered) {
                push(new Set([normalizedConnId]), sessionKey, state, cached, assertSourceCurrent);
              }
              return;
            }
            const snapshot = await loadSnapshot(sessionKey, isCurrent, refresh);
            assertSourceCurrent();
            // A removed/re-added key has a new cell; retained keys still need their result.
            if (isCurrent() && (refresh ? watched.delivered !== snapshot : !watched.delivered)) {
              push(new Set([normalizedConnId]), sessionKey, state, snapshot, assertSourceCurrent);
            }
          }).catch(() => {});
        }),
      );
    });
  };

  const unsubscribe = (connId: string) => {
    const normalizedConnId = connId.trim();
    if (!normalizedConnId) {
      return;
    }
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
