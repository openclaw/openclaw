import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import type { ApplicationGateway } from "../app/gateway.ts";
import { listen } from "../lib/reactive/listener.ts";
import { CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT } from "../pages/chat/chat-history-events.ts";
import {
  sidebarSnapshotInvalidationMatches,
  sidebarSnapshotDeletedSessionKey,
  subscribeSnapshotInvalidation,
} from "../pages/chat/session-snapshot-invalidation-events.ts";
import {
  consumeSidebarBootScope,
  sidebarSnapshotScopeKey,
  subscribeSidebarBootRetirement,
  type SidebarSnapshotScope,
} from "../pages/chat/session-snapshot-prewarm.ts";
import { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";
import { removeSidebarSnapshotSession } from "./sidebar-snapshot-data.ts";
import { parseSidebarSnapshot, type SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

export function createSidebarSnapshot(host: {
  sidebarSnapshot: SidebarSnapshotModel | null;
  readonly sessionDataContext?: {
    gateway: ApplicationGateway;
    agentSelection: { readonly state: { readonly scopeId: string | null } };
    connectionBootstrap: { readonly foregroundReady: boolean };
  };
  expandedAgentId(): string;
  captureSidebarSnapshot(): SidebarSnapshotModel | null;
  sidebarSnapshotSettled(): boolean;
  restoreSidebarSnapshot(model: SidebarSnapshotModel): void;
  releaseSidebarSnapshot(): void;
  clearSidebarSnapshot(): void;
}) {
  let publish: (() => void) | undefined;
  let pending = false;
  let saved = false;
  let lastCapture = "none";
  const store = new SessionSnapshotStore();
  let gateway: ApplicationGateway | undefined;
  let revision = -1;
  let scope: SidebarSnapshotScope | null = null;
  let generation = 0;
  let captured: { model: SidebarSnapshotModel; serialized: string } | null = null;
  let retirement = Promise.resolve();
  let cleanup: Array<() => void> = [];
  let stopGateway: (() => void) | undefined;
  let retiredHello: ApplicationGateway["snapshot"]["hello"] | undefined;
  let cancelCapture: (() => void) | undefined;
  let handoffIdle: number | undefined;
  let handoffReady = false;

  function subscribe(listener: () => void): () => void {
    publish = listener;
    return () => {
      publish = undefined;
    };
  }

  function notify(): void {
    publish?.();
  }

  function connect(): void {
    store.connect();
    cleanup = [
      listen(window, "pagehide", flushCapture),
      listen(document, CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT, () => {
        // The loading edge precedes the foreground pane's committed update.
        queueMicrotask(() => {
          synchronize();
          notify();
        });
      }),
      listen(document, "visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          flushCapture();
        }
      }),
      subscribeSnapshotInvalidation((event) => {
        if (!scope) {
          return;
        }
        const key = sidebarSnapshotScopeKey(scope);
        const deleted = sidebarSnapshotDeletedSessionKey(key, event);
        if (deleted) {
          // Cancel accepted stale captures, retaining the rest of the display and cache.
          generation += 1;
          cancelCapture?.();
          cancelCapture = undefined;
          pending = false;
          if (captured && saved) {
            const model = removeSidebarSnapshotSession(captured.model, deleted);
            if (model !== captured.model) {
              captured = { model, serialized: JSON.stringify(model) };
            }
          } else {
            captured = null;
          }
          if (host.sidebarSnapshot) {
            const model = removeSidebarSnapshotSession(host.sidebarSnapshot, deleted);
            if (model !== host.sidebarSnapshot) {
              host.restoreSidebarSnapshot(model);
              notify();
            }
          }
        } else if (sidebarSnapshotInvalidationMatches(key, event)) {
          clearDisplay();
        }
      }),
      subscribeSidebarBootRetirement(
        () => scope,
        () => {
          retiredHello = gateway?.snapshot.hello;
          replaceScope(null);
        },
      ),
    ];
    synchronize();
  }

  function synchronize(): void {
    if (!cleanup.length) {
      return;
    }
    const nextGateway = host.sessionDataContext?.gateway;
    if (nextGateway !== gateway) {
      stopGateway?.();
      replaceScope(null);
      gateway = nextGateway;
      revision = gateway?.connectionRevision ?? -1;
      retiredHello = undefined;
      if (gateway) {
        const boot = consumeSidebarBootScope(gateway);
        if (boot?.revision === revision) {
          scope = boot.scope;
          pending = true;
          const current = captureScope();
          void boot.snapshot.then((model) => {
            synchronize();
            if (!current()) {
              return;
            }
            pending = false;
            if (model && matchesAgent(model) && !host.sidebarSnapshotSettled()) {
              host.restoreSidebarSnapshot(model);
              captured = { model, serialized: JSON.stringify(model) };
              saved = true;
            }
            notify();
          });
        }
        // Connection receipts retire stale snapshot capture and restore the new scope.
        stopGateway = gateway.subscribe(() => {
          synchronize();
          notify();
        });
      }
    }
    if (!gateway) {
      return;
    }
    if (gateway.connectionRevision !== revision) {
      revision = gateway.connectionRevision;
      retiredHello = undefined;
      replaceScope(null);
    }
    const snapshot = gateway.snapshot;
    if (host.sidebarSnapshot && !matchesAgent(host.sidebarSnapshot)) {
      clearDisplay();
    }
    if (pending && host.sidebarSnapshotSettled()) {
      generation += 1;
      pending = false;
      notify();
    }
    if (snapshot.client?.offlineRecoveryRetired || snapshot.hello === retiredHello) {
      if (scope) {
        replaceScope(null);
      }
    } else if (snapshot.phase === "connected") {
      const recoveryScope = snapshot.hello?.auth?.recoveryScope;
      const next = recoveryScope
        ? {
            gatewayScope: gatewayCredentialScope(gateway.connection.gatewayUrl),
            recoveryScope,
            // Unresolved hello identity does not retire an admitted boot profile.
            profileId:
              snapshot.selfUser === undefined
                ? (scope?.profileId ?? null)
                : (snapshot.selfUser?.id ?? null),
          }
        : null;
      if (JSON.stringify(next) !== JSON.stringify(scope)) {
        replaceScope(next);
      }
    }
    if (snapshot.phase !== "connected") {
      cancelHandoff();
    } else if (host.sidebarSnapshot) {
      if (!host.sidebarSnapshotSettled()) {
        return;
      }
      if (!handoffReady) {
        if (host.sessionDataContext?.connectionBootstrap.foregroundReady) {
          if (typeof requestIdleCallback === "function") {
            handoffIdle ??= requestIdleCallback(releaseWhenReady, { timeout: 1800 });
          } else {
            handoffReady = true;
          }
        }
      }
      if (!handoffReady) {
        return;
      }
      cancelHandoff();
      // Release before rendering so a failed refresh cannot leave cached controls painted.
      host.releaseSidebarSnapshot();
    } else if (!captured) {
      // Readiness can settle without changing rows, so no render need follow this publication.
      capture();
    }
  }

  function releaseWhenReady(): void {
    handoffReady = true;
    synchronize();
    notify();
  }

  function cancelHandoff(): void {
    if (handoffIdle !== undefined) {
      cancelIdleCallback(handoffIdle);
    }
    handoffIdle = undefined;
    handoffReady = false;
  }

  function capture(): void {
    if (!cleanup.length || cancelCapture) {
      return;
    }
    // Coalesce live events before building the projection, not just before the IDB write.
    const timer = globalThis.setTimeout(() => {
      if (typeof globalThis.requestIdleCallback === "function") {
        const idle = globalThis.requestIdleCallback(flushCapture, { timeout: 1000 });
        cancelCapture = () => globalThis.cancelIdleCallback(idle);
      } else {
        flushCapture();
      }
    }, 500);
    cancelCapture = () => globalThis.clearTimeout(timer);
  }

  function flushCapture(): void {
    if (!cancelCapture) {
      return;
    }
    cancelCapture();
    cancelCapture = undefined;
    const blocked = !cleanup.length
      ? "disconnected"
      : pending
        ? "boot-read"
        : !scope
          ? "missing-scope"
          : scope.profileId !== null && gateway?.snapshot.selfUser === undefined
            ? "identity"
            : host.sidebarSnapshot
              ? "cached-display"
              : !host.sidebarSnapshotSettled()
                ? "unsettled"
                : null;
    if (blocked || !scope) {
      lastCapture = blocked ?? "missing-scope";
      return;
    }
    const model = host.captureSidebarSnapshot();
    if (!model) {
      lastCapture = "model-unavailable";
      return;
    }
    const next = { model, serialized: JSON.stringify(model) };
    if (next.serialized === captured?.serialized) {
      // Retain a failed/in-flight write's phase when an unchanged capture is skipped.
      return;
    }
    captured = next;
    saved = false;
    const current = captureScope();
    const key = sidebarSnapshotScopeKey(scope);
    lastCapture = "retiring";
    void retirement.then(async () => {
      if (!current()) {
        if (next === captured) {
          lastCapture = "superseded";
        }
        return;
      }
      lastCapture = "writing";
      const written = await store.writeSidebar(key, model, parseSidebarSnapshot);
      if (next === captured) {
        lastCapture = !current() ? "superseded" : written ? "saved" : "rejected";
      }
      if (written && current() && next === captured) {
        saved = true;
        notify();
      }
    });
  }

  function disconnect(): void {
    cleanup.splice(0).forEach((stop) => stop());
    stopGateway?.();
    store.disconnect();
    gateway = undefined;
    scope = null;
    clearDisplay();
  }

  function matchesAgent(model: SidebarSnapshotModel): boolean {
    return (
      (model.mode !== "chip" || model.roster?.agentId === host.expandedAgentId()) &&
      (model.navigationView !== "pages" ||
        model.pageScopeId === host.sessionDataContext?.agentSelection.state.scopeId)
    );
  }

  function captureScope(): () => boolean {
    const admittedGeneration = generation;
    const admittedGateway = gateway;
    const admittedRevision = revision;
    return () =>
      admittedGeneration === generation &&
      admittedGateway === host.sessionDataContext?.gateway &&
      admittedRevision === admittedGateway?.connectionRevision;
  }

  function replaceScope(next: SidebarSnapshotScope | null): void {
    const previous = scope;
    scope = next;
    clearDisplay();
    if (previous) {
      // A new hello may reuse this key; its writes must follow the old deletion.
      retirement = Promise.all([retirement, store.delete(sidebarSnapshotScopeKey(previous))]).then(
        () => undefined,
      );
    }
  }

  function clearDisplay(): void {
    cancelHandoff();
    cancelCapture?.();
    cancelCapture = undefined;
    generation += 1;
    pending = saved = false;
    lastCapture = "none";
    captured = null;
    host.clearSidebarSnapshot();
    notify();
  }

  return {
    read: () => ({ pending, saved, model: host.sidebarSnapshot }),
    diagnostics: () =>
      [
        lastCapture,
        Boolean(cancelCapture),
        cleanup.length > 0,
        pending,
        saved,
        scope !== null,
        scope?.profileId === null || gateway?.snapshot.selfUser !== undefined,
        host.sidebarSnapshot !== null,
        captured !== null,
        host.sidebarSnapshotSettled(),
      ] as const,
    subscribe,
    connect,
    disconnect,
    synchronize,
    capture,
  };
}
