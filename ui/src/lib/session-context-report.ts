import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import type { SessionSystemPromptReport } from "../../../src/config/sessions/session-system-prompt-report.js";
import { createChangeListeners } from "../../../src/shared/listeners.js";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { createGatewayConnectionLifecycle } from "./gateway-connection-lifecycle.ts";
import { isRetryableGatewayReadError } from "./gateway-errors.ts";
import { createGatewayRetryOwner } from "./gateway-retry.ts";
import { listen } from "./reactive/listener.ts";
import { areUiSessionKeysEquivalent, scopedSessionArtifactKey } from "./sessions/session-key.ts";
import { requestSessionUsage } from "./sessions/usage.ts";

type SessionContextReportTarget = {
  sessionKey: string;
  agentId?: string;
  sessionId?: string;
  model?: string;
  provider?: string;
  used: number;
};
type SessionContextReportSnapshot = {
  report: SessionSystemPromptReport | null;
  loading: boolean;
  failed: boolean;
  offline: boolean;
};
type SessionContextReportOutcome = "ready" | "failed" | "offline" | "retired";

type Entry = {
  target: SessionContextReportTarget;
  snapshot: SessionContextReportSnapshot;
  resolved: boolean;
  retry: ReturnType<typeof createGatewayRetryOwner>;
  request?: { controller: AbortController; promise: Promise<SessionContextReportOutcome> };
};
const stores = new WeakMap<ApplicationGateway, ReturnType<typeof createSessionContextReports>>();
const keyFor = (target: SessionContextReportTarget) =>
  JSON.stringify([
    scopedSessionArtifactKey(target.sessionKey, target.agentId),
    target.agentId,
    target.sessionId,
    target.model,
    target.provider,
  ]);

function createSessionContextReports(gateway: ApplicationGateway) {
  const changes = createChangeListeners();
  const entries = new Map<string, Entry>();
  const watchers = new Map<object, { key: string; presented: boolean }>();
  const connection = createGatewayConnectionLifecycle(gateway.snapshot);
  let scope = gatewayPresentationScope(gateway).key;
  let unsubscribe: (() => void) | undefined;
  let stopVisibility: (() => void) | undefined;
  const visible = () => document.visibilityState !== "hidden";
  const empty = (): SessionContextReportSnapshot => ({
    report: null,
    loading: gateway.snapshot.phase === "connected",
    failed: false,
    offline: gateway.snapshot.phase !== "connected",
  });
  const demanded = (key: string) =>
    [...watchers.values()].some((watcher) => watcher.key === key && watcher.presented);
  const cancel = (entry: Entry) => {
    entry.request?.controller.abort();
    delete entry.request;
    entry.snapshot = { ...entry.snapshot, loading: false };
  };

  function load(key: string, entry: Entry): Promise<SessionContextReportOutcome> {
    if (entry.request) {
      return entry.request.promise;
    }
    const receipt = connection.capture();
    if (!receipt || !demanded(key) || !visible()) {
      return Promise.resolve<SessionContextReportOutcome>("retired");
    }
    entry.retry.cancel();
    const controller = new AbortController();
    const requestScope = scope;
    const current = () =>
      entry.request?.controller === controller &&
      entries.get(key) === entry &&
      demanded(key) &&
      connection.isCurrent(receipt) &&
      gatewayPresentationScope(gateway).key === requestScope;
    const target = entry.target;
    const sessionKey = scopedSessionArtifactKey(target.sessionKey, target.agentId);
    const today = new Date().toISOString().slice(0, 10);
    const promise = requestSessionUsage(
      receipt.client,
      {
        startDate: today,
        endDate: today,
        timeZone: "utc",
        scope: "instance",
        agentId: target.agentId,
      },
      { key: sessionKey, includeContextWeight: true, signal: controller.signal },
    )
      .then((response): SessionContextReportOutcome => {
        if (!current() || entry.target.used !== target.used) {
          return "retired";
        }
        entry.retry.reset();
        const row = response.sessions.find((item) =>
          areUiSessionKeysEquivalent(item.key, sessionKey),
        );
        const report = row?.contextWeight;
        const matches =
          report &&
          (!target.sessionId ||
            (row?.sessionId === target.sessionId &&
              (!report.sessionId || report.sessionId === target.sessionId))) &&
          (!report.model || !target.model || report.model === target.model) &&
          (!report.provider || !target.provider || report.provider === target.provider);
        entry.snapshot = {
          report: matches ? report : null,
          loading: false,
          failed: false,
          offline: false,
        };
        entry.resolved = true;
        return "ready";
      })
      .catch((error: unknown): SessionContextReportOutcome => {
        if (!current()) {
          return "retired";
        }
        const transient = isRetryableGatewayReadError(error, "sessions.usage");
        entry.snapshot = {
          report: transient ? entry.snapshot.report : null,
          loading: false,
          failed: true,
          offline: false,
        };
        entry.resolved = true;
        if (transient) {
          entry.retry.schedule(
            () => {
              if (entries.get(key) === entry && demanded(key) && visible()) {
                void load(key, entry);
              }
            },
            error instanceof GatewayProtocolRequestError ? error.retryAfterMs : undefined,
          );
          if (!visible()) {
            entry.retry.pause();
          }
        } else {
          entry.retry.reset();
        }
        return "failed";
      })
      .finally(() => {
        if (entry.request?.controller !== controller) {
          return;
        }
        delete entry.request;
        if (!entry.resolved && entry.target.used !== target.used && demanded(key)) {
          void load(key, entry);
        } else {
          changes.publish();
        }
      });
    entry.request = { controller, promise };
    entry.resolved = false;
    entry.snapshot = { ...entry.snapshot, loading: true, failed: false, offline: false };
    changes.publish();
    return promise;
  }

  function connectionChanged() {
    const nextScope = gatewayPresentationScope(gateway).key;
    const changed = connection.transition(gateway.snapshot);
    if (!changed && nextScope === scope) {
      return;
    }
    scope = nextScope;
    for (const entry of entries.values()) {
      cancel(entry);
      entry.retry.reset();
      entry.resolved = false;
      entry.snapshot = empty();
    }
    changes.publish();
    for (const [key, entry] of entries) {
      if (demanded(key)) {
        void load(key, entry);
      }
    }
  }

  function releaseUnused() {
    for (const [key, entry] of entries) {
      const retained = [...watchers.values()].some((watcher) => watcher.key === key);
      if (!retained || !demanded(key)) {
        cancel(entry);
        entry.retry.pause();
      }
      if (!retained) {
        entry.retry.cancel();
        entries.delete(key);
      }
    }
    if (watchers.size === 0) {
      unsubscribe?.();
      unsubscribe = undefined;
      stopVisibility?.();
      stopVisibility = undefined;
    }
  }

  function visibilityChanged() {
    for (const [key, entry] of entries) {
      if (!visible()) {
        cancel(entry);
        entry.retry.pause();
      } else if (demanded(key) && !entry.retry.resume() && !entry.resolved) {
        void load(key, entry);
      }
    }
    changes.publish();
  }

  return {
    subscribe: changes.subscribe,
    get(target: SessionContextReportTarget): SessionContextReportSnapshot {
      return entries.get(keyFor(target))?.snapshot ?? empty();
    },
    watch(owner: object, target: SessionContextReportTarget, presented = true) {
      if (!unsubscribe) {
        connectionChanged();
        unsubscribe = gateway.subscribe(connectionChanged);
        stopVisibility = listen(document, "visibilitychange", visibilityChanged);
      }
      const key = keyFor(target);
      watchers.set(owner, { key, presented });
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          target: { ...target },
          snapshot: empty(),
          resolved: false,
          retry: createGatewayRetryOwner(),
        };
        entries.set(key, entry);
      }
      const usageChanged = presented && entry.target.used !== target.used;
      if (usageChanged) {
        entry.target = { ...target };
        entry.resolved = false;
      }
      releaseUnused();
      if (presented && visible()) {
        if (!entry.retry.resume() && (usageChanged || !entry.resolved)) {
          void load(key, entry);
        }
      }
      changes.publish();
    },
    unwatch(owner: object) {
      if (!watchers.delete(owner)) {
        return;
      }
      releaseUnused();
      changes.publish();
    },
    refresh(target: SessionContextReportTarget) {
      const key = keyFor(target);
      const entry = entries.get(key);
      if (entry && demanded(key) && visible() && !connection.capture()) {
        return Promise.resolve<SessionContextReportOutcome>("offline");
      }
      return entry ? load(key, entry) : Promise.resolve<SessionContextReportOutcome>("retired");
    },
  };
}

/** A retained pane and its composer popover share one scoped read and accepted result. */
export function sessionContextReportsForGateway(gateway: ApplicationGateway) {
  let store = stores.get(gateway);
  if (!store) {
    store = createSessionContextReports(gateway);
    stores.set(gateway, store);
  }
  return store;
}
