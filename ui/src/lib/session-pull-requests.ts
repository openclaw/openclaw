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
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
} from "../../../src/gateway/control-ui-contract.js";
import { operatorScopeSatisfied } from "../../../src/shared/operator-scope-compat.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import { createGatewayConnectionLifecycle } from "./gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "./gateway-methods.ts";
import { createGatewaySetSyncLifecycle } from "./gateway-set-sync-lifecycle.ts";
import { primarySessionPullRequest } from "./session-pull-request-presentation.ts";
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
  const current = primarySessionPullRequest(pullRequests);
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
  let orderedPassiveKeys: string[] = [];
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
  let subscriptionMayExist = false;
  let refreshing: readonly string[] | null = null;

  const canReadPullRequests = () =>
    canCallGatewayMethod(gateway.snapshot, SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, "operator.read");
  const canReadAllPullRequests = () =>
    operatorScopeSatisfied("operator.read", gateway.snapshot.hello?.auth?.scopes ?? []);
  let broadRead = canReadAllPullRequests();

  const notify = () => Array.from(listeners).forEach((listener) => listener());

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
      if (watched.passive && !canReadAllPullRequests()) {
        continue;
      }
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
    orderedPassiveKeys = ordered.filter(([, priority]) => priority === 0).map(([key]) => key);
    return orderedWatchedKeys;
  };

  // Passive rows request only durable receipts; active viewers also poll Git/GitHub.
  const requestedKeys = () => {
    watchedKeys();
    return orderedRequestedKeys;
  };

  const pruneUnwatched = () => {
    const watched = new Set(watchedKeys());
    const requested = new Set(requestedKeys());
    let removed = false;
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
        removed = true;
      }
    }
    if (removed) {
      notify();
    }
  };

  const isActive = () => watchedByOwner.size > 0 || listeners.size > 0 || waiters.size > 0;

  const retainRefreshIntent = (keys: readonly string[]) => {
    for (const key of refreshing ?? []) {
      if (keys.includes(key)) {
        pendingRefreshKeys.add(key);
      }
    }
  };

  const retireConnection = () => {
    subscriptionMayExist = false;
    retainRefreshIntent(watchedKeys());
    lifecycle.clearRequest();
    refreshing = null;
    clearSnapshotsAndWaiters();
  };

  const handleGatewaySnapshot = (snapshot: ApplicationGateway["snapshot"]) => {
    const changed = connection.transition(snapshot);
    const nextBroadRead = canReadAllPullRequests();
    const readScopeChanged = broadRead !== nextBroadRead;
    broadRead = nextBroadRead;
    if (changed || readScopeChanged) {
      orderedWatchedKeys = undefined;
      retireConnection();
    }
    if (changed || readScopeChanged || snapshot.hello !== lifecycle.requestHello) {
      lifecycle.resetRetry();
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
      if (
        !changed &&
        ["delete", "sharing", "profile-identity"].includes(String(reason)) &&
        !operatorScopeSatisfied("operator.read", gateway.snapshot.hello?.auth?.scopes ?? [])
      ) {
        clearSnapshotsAndWaiters();
        for (const key of watchedKeys()) {
          refresh(key);
        }
        return;
      }
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
        !snapshot.discardPrevious &&
        canRetainCurrent &&
        (snapshot.branchRead === false ||
          snapshot.status === "rate-limited" ||
          snapshot.status === "unavailable") &&
        snapshot.pullRequests.length === 0
      ) {
        next = {
          ...snapshot,
          pullRequests: current.pullRequests,
          branch: snapshot.branch ?? current.branch,
          repository: snapshot.repository ?? current.repository,
        };
      }
      if (snapshot.branchRead === false && current?.taskPullRequests) {
        const retained = new Map(
          current.taskPullRequests.map((task) => [task.url, task.pullRequest]),
        );
        next = {
          ...next,
          // Membership is authoritative even when passive reads omit GitHub metadata.
          taskPullRequests: snapshot.taskPullRequests?.map((task) =>
            Object.assign({}, task, { pullRequest: task.pullRequest ?? retained.get(task.url) }),
          ),
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
      handleGatewaySnapshot(gateway.snapshot);
      lifecycle.clearRequest();
    },
    onDetach: () => {
      refreshing = null;
      snapshots.clear();
      for (const timer of automaticRefreshTimers.values()) {
        clearTimeout(timer);
      }
      automaticRefreshTimers.clear();
    },
  });

  function sync() {
    const snapshot = gateway.snapshot;
    const client = snapshot.client;
    if (!canReadPullRequests() || !client) {
      retainRefreshIntent(watchedKeys());
      lifecycle.clearRequest();
      clearSnapshotsAndWaiters();
      if (!isActive()) {
        lifecycle.detach();
      }
      return;
    }
    const desiredKeys = requestedKeys();
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    const sessionKeys = hidden ? [] : desiredKeys;
    const passiveSessionKeys = hidden ? [] : orderedPassiveKeys;
    const signature = JSON.stringify([sessionKeys.toSorted(), passiveSessionKeys.toSorted()]);
    // Capability changes do not clear a subscription already sent on this connection.
    if (sessionKeys.length === 0 && passiveSessionKeys.length === 0 && !subscriptionMayExist) {
      if (!isActive()) {
        lifecycle.detach();
      }
      return;
    }
    const sameRequest = lifecycle.matchesRequest(signature);
    if (refreshing !== null && !sameRequest) {
      // A replacement retires the old acknowledgement, not its retained intent.
      // Hidden tabs keep desired keys so their refresh resumes when shown again.
      retainRefreshIntent(desiredKeys);
    }
    const sessionKeySet = new Set(sessionKeys);
    const refreshSessionKeys = [...pendingRefreshKeys].filter((key) => sessionKeySet.has(key));
    if (sameRequest && refreshSessionKeys.length === 0) {
      if (!isActive()) {
        lifecycle.detach();
      }
      return;
    }
    // Repeated hints for the same watched union coalesce behind its current
    // request. Membership changes still supersede immediately (notably hide).
    if (refreshing !== null && sameRequest) {
      return;
    }
    refreshing = refreshSessionKeys;
    for (const key of refreshSessionKeys) {
      pendingRefreshKeys.delete(key);
    }
    subscriptionMayExist ||= sessionKeys.length > 0 || passiveSessionKeys.length > 0;
    lifecycle.send(
      client,
      SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      {
        sessionKeys,
        ...(passiveSessionKeys.length > 0 ? { passiveSessionKeys } : {}),
        ...(refreshSessionKeys.length > 0 ? { refreshSessionKeys } : {}),
      },
      signature,
      {
        onSuccess: () => {
          subscriptionMayExist = sessionKeys.length > 0 || passiveSessionKeys.length > 0;
        },
        onError: () => {
          for (const key of refreshSessionKeys) {
            pendingRefreshKeys.add(key);
          }
          lifecycle.scheduleRetry(() => {
            if (lifecycle.attached && isActive()) {
              lifecycle.schedule();
            }
          });
          for (const key of sessionKeys) {
            settle(key);
          }
        },
        onSettled: (acknowledged) => {
          refreshing = null;
          if (acknowledged && pendingRefreshKeys.size > 0) {
            lifecycle.schedule();
          }
        },
      },
    );
    if (!isActive()) {
      lifecycle.detach();
    }
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
    lifecycle.resetRetry();
    pruneUnwatched();
    if (isActive()) {
      if (!wasActive) {
        lifecycle.clearRequest();
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
      lifecycle.resetRetry();
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
        lifecycle.clearRequest();
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
