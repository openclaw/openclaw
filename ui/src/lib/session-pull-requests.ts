import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionCatalogPullRequestSummary } from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequests,
  ControlUiSessionPullRequestSnapshot,
  ControlUiSessionPullRequestsChanged,
} from "../../../src/gateway/control-ui-contract.js";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS,
} from "../../../src/gateway/control-ui-contract.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import { createGatewayConnectionLifecycle } from "./gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "./gateway-methods.ts";
import { createGatewaySetSyncLifecycle } from "./gateway-set-sync-lifecycle.ts";
import { readSessionChangedEvent } from "./sessions/reconcile.ts";
import { uiSessionEventMatches } from "./sessions/session-key.ts";

export function sessionGitHubRepository(
  snapshot: ControlUiSessionPullRequests | undefined,
): { owner: string; repo: string } | null {
  const repository = snapshot?.repository ?? snapshot?.branch ?? snapshot?.pullRequests[0];
  return repository ? { owner: repository.owner, repo: repository.repo } : null;
}

export function summarizeSessionPullRequests(
  pullRequests: readonly ControlUiSessionPullRequest[],
  previous?: SessionCatalogPullRequestSummary,
): SessionCatalogPullRequestSummary | undefined {
  // Keep active work ahead of newer merged/closed history, as the sidebar and PR menu do.
  const current =
    pullRequests.find(({ state }) => state === "open") ??
    pullRequests.find(({ state }) => state === "draft") ??
    pullRequests.find(({ state }) => state === "merged") ??
    pullRequests[0];
  if (!current) {
    return undefined;
  }
  const numbers = [...new Set(pullRequests.map((pullRequest) => pullRequest.number))]
    .slice(0, 20)
    .toSorted((left, right) => left - right);
  return previous?.state === current.state && previous.numbers.join(",") === numbers.join(",")
    ? previous
    : { numbers, state: current.state };
}

export const SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD = "controlUi.sessionPullRequests.subscribe";

const STRUCTURAL_SESSION_REASONS = new Set<unknown>([
  "new",
  "reset",
  "branch-switch",
  "fork",
  "rewind",
]);

export type SessionPullRequestSnapshotStore = {
  watch: (
    owner: object,
    sessionKeys: readonly string[],
    options?: { foreground?: boolean; passive?: boolean },
  ) => void;
  unwatch: (owner: object) => void;
  load: (
    owner: object,
    sessionKey: string,
  ) => Promise<ControlUiSessionPullRequestSnapshot | undefined>;
  refresh: (sessionKey: string, options?: { automatic?: boolean }) => boolean;
  get: (sessionKey: string) => ControlUiSessionPullRequestSnapshot | undefined;
  subscribe: (listener: () => void) => () => void;
};

const stores = new WeakMap<ApplicationGateway, SessionPullRequestSnapshotStore>();

function readChangedSessions(
  payload: unknown,
): ControlUiSessionPullRequestsChanged["sessions"] | null {
  if (!payload || typeof payload !== "object" || !("sessions" in payload)) {
    return null;
  }
  const sessions = (payload as { sessions?: unknown }).sessions;
  return asNullableRecord(sessions) as ControlUiSessionPullRequestsChanged["sessions"] | null;
}

export function sessionPullRequestsForGateway(
  gateway: ApplicationGateway,
): SessionPullRequestSnapshotStore {
  const existing = stores.get(gateway);
  if (existing) {
    return existing;
  }
  const watchedByOwner = new Map<
    object,
    { keys: Set<string>; foreground: boolean; passive: boolean }
  >();
  let orderedWatchedKeys: string[] | undefined;
  let orderedRequestedKeys: string[] = [];
  const loadTokens = new WeakMap<object, object>();
  const snapshots = new Map<string, ControlUiSessionPullRequestSnapshot>();
  const listeners = new Set<() => void>();
  const waiters = new Map<
    string,
    Set<(snapshot: ControlUiSessionPullRequestSnapshot | undefined) => void>
  >();
  const pendingRefreshKeys = new Set<string>();
  const automaticRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const connection = createGatewayConnectionLifecycle(gateway.snapshot);
  let lastHello: object | null = null;
  let lastSignature: string | null = null;
  let syncRequestGeneration = 0;
  let refreshing: { generation: number; keys: readonly string[] } | null = null;
  let requestController: AbortController | null = null;

  const canReadPullRequests = () =>
    canCallGatewayMethod(gateway.snapshot, SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, "operator.read");

  const retireRequest = () => {
    requestController?.abort();
    requestController = null;
  };

  const notify = () => {
    for (const listener of Array.from(listeners)) {
      listener();
    }
  };

  const settle = (sessionKey: string, snapshot?: ControlUiSessionPullRequestSnapshot) => {
    const pending = waiters.get(sessionKey);
    if (!pending) {
      return;
    }
    waiters.delete(sessionKey);
    for (const resolve of pending) {
      resolve(snapshot);
    }
  };

  const clearSnapshotsAndWaiters = () => {
    const hadSnapshots = snapshots.size > 0;
    snapshots.clear();
    for (const key of waiters.keys()) {
      settle(key);
    }
    if (hadSnapshots) {
      notify();
    }
  };

  const matchesSession = (sessionKey: string, eventKey: string, agentId?: string | null) =>
    uiSessionEventMatches(
      {
        assistantAgentId: gateway.snapshot.assistantAgentId,
        hello: gateway.snapshot.hello,
        sessionKey,
      },
      eventKey,
      agentId,
    );

  const watchedKeys = (): string[] => {
    if (orderedWatchedKeys) {
      return orderedWatchedKeys;
    }
    const keys = new Map<string, number>();
    for (const watched of watchedByOwner.values()) {
      for (const key of watched.keys) {
        const priority = watched.passive ? 0 : watched.foreground ? 2 : 1;
        keys.set(key, Math.max(keys.get(key) ?? 0, priority));
      }
    }
    const ordered = [...keys]
      .toSorted(
        ([leftKey, leftPriority], [rightKey, rightPriority]) =>
          rightPriority - leftPriority || leftKey.localeCompare(rightKey),
      )
      .slice(0, CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS);
    orderedWatchedKeys = ordered.map(([key]) => key);
    orderedRequestedKeys = ordered.filter(([, priority]) => priority > 0).map(([key]) => key);
    return orderedWatchedKeys;
  };

  // Passive row decoration retains snapshots without asking the Gateway to poll Git.
  const requestedKeys = () => {
    watchedKeys();
    return orderedRequestedKeys;
  };

  const pruneUnwatched = () => {
    const watched = new Set(watchedKeys());
    const requested = new Set(requestedKeys());
    for (const [key, timer] of automaticRefreshTimers) {
      if (!requested.has(key)) {
        clearTimeout(timer);
        automaticRefreshTimers.delete(key);
      }
    }
    for (const key of pendingRefreshKeys) {
      if (!requested.has(key)) {
        pendingRefreshKeys.delete(key);
      }
    }
    for (const key of waiters.keys()) {
      if (!requested.has(key)) {
        settle(key);
      }
    }
    for (const key of snapshots.keys()) {
      if (!watched.has(key)) {
        snapshots.delete(key);
      }
    }
  };

  const isActive = () => watchedByOwner.size > 0 || listeners.size > 0 || waiters.size > 0;

  const retainRefreshIntent = (keys: readonly string[]) => {
    for (const key of refreshing?.keys ?? []) {
      if (keys.includes(key)) {
        pendingRefreshKeys.add(key);
      }
    }
  };

  const retireConnection = () => {
    retainRefreshIntent(watchedKeys());
    syncRequestGeneration += 1;
    retireRequest();
    refreshing = null;
    lastHello = null;
    lastSignature = null;
    clearSnapshotsAndWaiters();
  };

  const handleGatewaySnapshot = (snapshot: ApplicationGateway["snapshot"]) => {
    const changed = connection.transition(snapshot);
    if (changed) {
      retireConnection();
    }
    if (changed || snapshot.hello !== lastHello) {
      retry.reset();
      lifecycle.schedule();
    }
  };

  const handleGatewayEvent: Parameters<ApplicationGateway["subscribeEvents"]>[0] = (event) => {
    if (event.event === "agent" || event.event === "session.tool") {
      const payload = asNullableRecord(event.payload);
      const data = asNullableRecord(payload?.data);
      if (
        typeof payload?.sessionKey !== "string" ||
        !(
          (payload.stream === "tool" && data?.phase === "result") ||
          (payload.stream === "lifecycle" && (data?.phase === "end" || data?.phase === "error"))
        )
      ) {
        return;
      }
      for (const sessionKey of requestedKeys()) {
        if (
          matchesSession(
            sessionKey,
            payload.sessionKey,
            typeof payload.agentId === "string" ? payload.agentId : undefined,
          )
        ) {
          refresh(sessionKey, { automatic: true });
        }
      }
      return;
    }
    if (event.event === "sessions.changed") {
      const changed = readSessionChangedEvent(event.payload);
      const reason = asNullableRecord(event.payload)?.reason;
      if (!changed || !STRUCTURAL_SESSION_REASONS.has(reason)) {
        return;
      }
      const matchingKeys = watchedKeys().filter((sessionKey) =>
        matchesSession(sessionKey, changed.key, changed.agentId),
      );
      if (matchingKeys.length === 0) {
        return;
      }
      let removed = false;
      for (const sessionKey of matchingKeys) {
        removed = snapshots.delete(sessionKey) || removed;
        refresh(sessionKey, { automatic: true });
      }
      if (removed) {
        notify();
      }
      return;
    }
    if (event.event !== CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT) {
      return;
    }
    const changed = readChangedSessions(event.payload);
    if (!changed) {
      return;
    }
    const watched = new Set(watchedKeys());
    let updated = false;
    for (const [sessionKey, snapshot] of Object.entries(changed)) {
      if (!watched.has(sessionKey)) {
        continue;
      }
      const current = snapshots.get(sessionKey);
      const repository = sessionGitHubRepository(snapshot);
      const currentRepository = sessionGitHubRepository(current);
      const currentBranch = current?.branch?.branch ?? current?.pullRequests[0]?.branch;
      const canRetainCurrent =
        (!repository ||
          (repository.owner === currentRepository?.owner &&
            repository.repo === currentRepository?.repo)) &&
        (!snapshot.branch || !currentBranch || snapshot.branch.branch === currentBranch);
      let next = snapshot;
      if (
        current &&
        canRetainCurrent &&
        (snapshot.status === "rate-limited" || snapshot.status === "unavailable") &&
        snapshot.pullRequests.length === 0
      ) {
        next = {
          ...snapshot,
          pullRequests: current.pullRequests,
          branch: snapshot.branch ?? current.branch,
          repository: snapshot.repository ?? current.repository,
        };
      }
      snapshots.set(sessionKey, next);
      updated = true;
      settle(sessionKey, next);
    }
    if (updated) {
      notify();
    }
  };

  const lifecycle = createGatewaySetSyncLifecycle(gateway, {
    sync,
    onSnapshot: handleGatewaySnapshot,
    onEvent: handleGatewayEvent,
    onAttach: () => {
      if (connection.transition(gateway.snapshot)) {
        retireConnection();
      }
      lastHello = null;
      lastSignature = null;
    },
    onDetach: () => {
      syncRequestGeneration += 1;
      retireRequest();
      refreshing = null;
      lastHello = null;
      lastSignature = null;
      snapshots.clear();
      for (const timer of automaticRefreshTimers.values()) {
        clearTimeout(timer);
      }
      automaticRefreshTimers.clear();
    },
  });
  const { retry } = lifecycle;

  function sync() {
    const snapshot = gateway.snapshot;
    const client = snapshot.client;
    if (!canReadPullRequests() || !client) {
      retainRefreshIntent(watchedKeys());
      lastHello = null;
      lastSignature = null;
      retireRequest();
      clearSnapshotsAndWaiters();
      if (!isActive()) {
        lifecycle.detach();
      }
      return;
    }
    const desiredKeys = requestedKeys();
    const sessionKeys =
      typeof document !== "undefined" && document.visibilityState === "hidden" ? [] : desiredKeys;
    const signature = JSON.stringify(sessionKeys.toSorted());
    if (refreshing !== null && (signature !== lastSignature || snapshot.hello !== lastHello)) {
      // A replacement retires the old acknowledgement, not its retained intent.
      // Hidden tabs keep desired keys so their refresh resumes when shown again.
      retainRefreshIntent(desiredKeys);
    }
    const sessionKeySet = new Set(sessionKeys);
    const refreshSessionKeys = [...pendingRefreshKeys].filter((key) => sessionKeySet.has(key));
    if (
      snapshot.hello === lastHello &&
      signature === lastSignature &&
      refreshSessionKeys.length === 0
    ) {
      if (!isActive()) {
        lifecycle.detach();
      }
      return;
    }
    // Repeated hints for the same watched union coalesce behind its current
    // request. Membership changes still supersede immediately (notably hide).
    if (refreshing !== null && snapshot.hello === lastHello && signature === lastSignature) {
      return;
    }
    lastHello = snapshot.hello;
    lastSignature = signature;
    const requestGeneration = ++syncRequestGeneration;
    // Fence retired catches before aborting a superseded local waiter.
    retireRequest();
    requestController = new AbortController();
    const isCurrentRequest = () =>
      lifecycle.attached &&
      isActive() &&
      requestGeneration === syncRequestGeneration &&
      snapshot.hello === lastHello &&
      signature === lastSignature;
    retry.cancel();
    refreshing = { generation: requestGeneration, keys: refreshSessionKeys };
    for (const key of refreshSessionKeys) {
      pendingRefreshKeys.delete(key);
    }
    const request = client.request(
      SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      { sessionKeys, ...(refreshSessionKeys.length > 0 ? { refreshSessionKeys } : {}) },
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, signal: requestController.signal },
    );
    if (!isActive()) {
      lifecycle.detach();
    }
    void request
      .then(() => {
        if (isCurrentRequest()) {
          retry.reset();
        }
      })
      .catch(() => {
        if (isCurrentRequest()) {
          for (const key of refreshSessionKeys) {
            pendingRefreshKeys.add(key);
          }
          lastSignature = null;
          retry.schedule(() => {
            if (lifecycle.attached && isActive()) {
              lifecycle.schedule();
            }
          });
          for (const key of sessionKeys) {
            settle(key);
          }
        }
      })
      .finally(() => {
        if (refreshing?.generation === requestGeneration) {
          refreshing = null;
          if (isCurrentRequest() && pendingRefreshKeys.size > 0) {
            lifecycle.schedule();
          }
        }
      });
  }

  const watch = (
    owner: object,
    sessionKeys: readonly string[],
    options: { foreground?: boolean; passive?: boolean } = {},
  ) => {
    const wasActive = isActive();
    const next = new Set(sessionKeys.map((key) => key.trim()).filter(Boolean));
    const current = watchedByOwner.get(owner);
    const unchanged =
      current === undefined
        ? next.size === 0
        : current.keys.size === next.size &&
          current.foreground === (options.foreground === true) &&
          current.passive === (options.passive === true) &&
          [...next].every((sessionKey) => current.keys.has(sessionKey));
    if (unchanged) {
      return;
    }
    if (next.size === 0) {
      watchedByOwner.delete(owner);
    } else {
      watchedByOwner.set(owner, {
        keys: next,
        foreground: options.foreground === true,
        passive: options.passive === true,
      });
    }
    orderedWatchedKeys = undefined;
    retry.reset();
    pruneUnwatched();
    if (isActive()) {
      if (!wasActive) {
        lastHello = null;
        lastSignature = null;
      }
      lifecycle.attach();
      lifecycle.schedule();
    } else if (lifecycle.attached) {
      lifecycle.sync();
    }
  };

  function refresh(sessionKey: string, options: { automatic?: boolean } = {}): boolean {
    const key = sessionKey.trim();
    if (!key || !requestedKeys().includes(key)) {
      return false;
    }
    clearTimeout(automaticRefreshTimers.get(key));
    automaticRefreshTimers.delete(key);
    if (options.automatic) {
      automaticRefreshTimers.set(
        key,
        setTimeout(() => refresh(key), 5_000),
      );
    } else {
      pendingRefreshKeys.add(key);
      retry.reset();
      lifecycle.schedule();
    }
    return true;
  }

  const store: SessionPullRequestSnapshotStore = {
    watch,
    unwatch: (owner) => {
      loadTokens.delete(owner);
      watch(owner, []);
    },
    load: async (owner, sessionKey) => {
      const key = sessionKey.trim();
      if (!key) {
        return undefined;
      }
      const loadToken = {};
      loadTokens.set(owner, loadToken);
      const alreadyRequested = requestedKeys().includes(key);
      // A one-shot load owns a foreground watch until it settles, which attaches the store
      // before the waiter is registered and keeps gateway events available for resolution.
      watch(owner, [key], { foreground: true });
      try {
        if (!canReadPullRequests()) {
          return undefined;
        }
        const current = snapshots.get(key);
        if (current && alreadyRequested) {
          return current;
        }
        if (current) {
          refresh(key);
        }
        return await new Promise((resolve) => {
          const pending = waiters.get(key) ?? new Set();
          pending.add(resolve);
          waiters.set(key, pending);
          lifecycle.schedule();
        });
      } finally {
        const currentWatch = watchedByOwner.get(owner);
        if (
          loadTokens.get(owner) === loadToken &&
          currentWatch?.keys.size === 1 &&
          currentWatch.keys.has(key)
        ) {
          loadTokens.delete(owner);
          watch(owner, []);
        }
      }
    },
    refresh,
    get: (sessionKey) => (canReadPullRequests() ? snapshots.get(sessionKey) : undefined),
    subscribe: (listener) => {
      const wasActive = isActive();
      listeners.add(listener);
      if (!wasActive) {
        lastHello = null;
        lastSignature = null;
      }
      lifecycle.attach();
      return () => {
        if (listeners.delete(listener)) {
          if (isActive()) {
            lifecycle.schedule();
          } else if (lifecycle.attached) {
            lifecycle.sync();
          }
        }
      };
    },
  };
  stores.set(gateway, store);
  return store;
}
