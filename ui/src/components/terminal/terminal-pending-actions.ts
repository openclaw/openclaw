import type { CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { TerminalPanelToggleDetail } from "../panel-toggle-contract.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import { disposeTerminalController } from "./terminal-controller-lifecycle.ts";
import type {
  TerminalPanelAction,
  TerminalPanelError,
  TerminalPanelSessionTab,
  TerminalPanelSessionState,
} from "./terminal-panel-session-types.ts";
import {
  loadPersistedTerminalActions,
  persistTerminalActions,
} from "./terminal-session-storage.ts";
import { CATALOG_TERMINAL_READY_TIMEOUT_MS } from "./terminal-tab-readiness.ts";
import type { TerminalTaskQueue } from "./terminal-task-queue.ts";

type TerminalHandoff = {
  kind: "handoff";
  tab: TerminalPanelSessionTab;
  client: TerminalGatewayClient | null;
  error: TerminalPanelError | null;
};
type QueuedTerminalAction = TerminalPanelAction | TerminalHandoff;

export type TerminalIntentHost = {
  bootQueue: Pick<TerminalTaskQueue, "enqueue">;
  currentGeneration: () => number;
  canRun: () => boolean;
  attach: (sessionId: string, agentOwned: boolean, cancelIntent: () => void) => Promise<boolean>;
  client: () => TerminalGatewayClient | null;
  present: (tab: TerminalPanelSessionTab) => void;
  showError: (text: string) => void;
  open: (
    catalog: CatalogSessionKey | undefined,
    agentId: string | null,
    cancelIntent: () => void,
  ) => Promise<boolean>;
  reattach: (cancelIntent?: () => void) => Promise<boolean>;
  cancelledRestoreCompleted: () => void;
  ensureInitial: (agentId: string | null, cancelIntent: () => void) => Promise<boolean>;
  hasTabs: () => boolean;
  publish: () => void;
  setBooting: (booting: boolean) => void;
  showTimeout: () => void;
  clearTimeout: () => void;
};

/**
 * One terminal intent queue per document. Panels come and go — a session route
 * mounts the side-panel terminal beside the shell's bottom-dock instance — but
 * the queue, its persisted copy, and the reconnect fence must not: two owners
 * over one storage key drop each other's intents and run the same open twice.
 * Hosts bind while connected; the most recent binding executes.
 */
export function createTerminalIntentQueue(persistent = true) {
  let ownedActions: QueuedTerminalAction[] = [];
  let ownedRefreshPending = false;
  let ownedRefreshTimedOut = false;
  let ownedRefreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let ownedDrainScheduled = false;
  let ownedHosts: TerminalIntentHost[] = [];
  let ownedFenceHost: TerminalIntentHost | null = null;
  let ownedFenceGeneration = 0;
  let ownedTimeoutHost: TerminalIntentHost | null = null;
  /**
   * Mirrors the persisted record whenever no panel is bound, so a document with
   * its terminals unmounted resumes exactly like a freshly loaded one.
   */
  function rehydrate(): void {
    if (!persistent || ownedActions.some((action) => action.kind === "handoff")) {
      return;
    }
    const persisted = loadPersistedTerminalActions();
    // Explicit user work supersedes a generic reconnect restore. Otherwise the
    // restored shell would open first and obscure the action the operator chose.
    const admitted = persisted.some((action) => action.kind !== "restore")
      ? persisted.filter((action) => action.kind !== "restore")
      : persisted;
    ownedActions = admitted;
    if (admitted.length !== persisted.length) {
      persist();
    }
  }

  function persist(): void {
    if (persistent) {
      persistTerminalActions(
        ownedActions.flatMap((action): TerminalPanelAction[] => {
          if (action.kind !== "handoff") {
            return [action];
          }
          // Only live PTYs can be restored after a document reload. Diagnostic
          // emulators belong to this document and never become dead attach intents.
          const tab = action.tab;
          return tab.status === "exited"
            ? []
            : [
                {
                  kind: "attach",
                  sessionId: tab.gatewaySessionId,
                  agentOwned: tab.agentOwned ?? false,
                },
              ];
        }),
      );
    }
  }

  function readHost(): TerminalIntentHost | null {
    return ownedHosts.at(-1) ?? null;
  }

  function retireAction(action: QueuedTerminalAction): void {
    const index = ownedActions.indexOf(action);
    if (index !== -1) {
      ownedActions.splice(index, 1);
      persist();
    }
  }

  function discardRestoreActions(): boolean {
    const count = ownedActions.length;
    ownedActions = ownedActions.filter((action) => action.kind !== "restore");
    return count !== ownedActions.length;
  }

  function canRun(host: TerminalIntentHost): boolean {
    return !ownedRefreshPending && host.canRun();
  }

  async function execute(
    host: TerminalIntentHost,
    action: QueuedTerminalAction,
    cancelIntent: () => void,
  ): Promise<boolean | "cancelled-restore"> {
    if (action.kind === "handoff") {
      const { tab, client, error } = action;
      if (client !== host.client()) {
        if (tab.status === "exited") {
          disposeTerminalController(tab.controller, tab.host);
        }
        return true;
      }
      const generation = host.currentGeneration();
      if (tab.status === "exited") {
        // Publish ownership synchronously: closing the destination must never
        // dispose a view both as a pending handoff and as an adopted tab.
        retireAction(action);
        host.present(tab);
      } else if (
        !(await host.attach(tab.gatewaySessionId, tab.agentOwned ?? false, cancelIntent))
      ) {
        return false;
      }
      if (error && canRun(host) && generation === host.currentGeneration()) {
        host.showError(error.text);
      }
      return true;
    }
    if (action.kind === "attach") {
      return host.attach(action.sessionId, action.agentOwned, cancelIntent);
    }
    if (action.kind === "open") {
      return host.open(undefined, action.agentId, cancelIntent);
    }
    const userClosedTab = await host.reattach(action.kind === "restore" ? cancelIntent : undefined);
    // A second panel mounting mid-flight must not strand this action: the host
    // that started it is still connected, so it finishes what it began.
    if (!canRun(host)) {
      return false;
    }
    return action.kind === "catalog"
      ? host.open(action.catalog, action.agentId, cancelIntent)
      : userClosedTab
        ? "cancelled-restore"
        : host.ensureInitial(action.agentId, cancelIntent);
  }

  function clearRefreshTimer(): void {
    if (ownedRefreshTimer !== null) {
      globalThis.clearTimeout(ownedRefreshTimer);
      ownedRefreshTimer = null;
    }
  }

  function clearRefreshFailure(): void {
    if (ownedRefreshTimedOut) {
      // The panel that surfaced the timeout owns the text that clears it.
      ownedTimeoutHost?.clearTimeout();
      ownedTimeoutHost = null;
      ownedRefreshTimedOut = false;
    }
  }

  function armRefreshTimer(): void {
    const fenceHost = ownedFenceHost;
    if (!ownedRefreshPending || !fenceHost || ownedRefreshTimer !== null) {
      return;
    }
    if (ownedActions.length === 0) {
      return;
    }
    const generation = ownedFenceGeneration;
    ownedRefreshTimer = globalThis.setTimeout(() => {
      ownedRefreshTimer = null;
      if (
        ownedFenceHost !== fenceHost ||
        generation !== fenceHost.currentGeneration() ||
        !ownedRefreshPending ||
        ownedActions.length === 0
      ) {
        return;
      }
      ownedRefreshTimedOut = true;
      ownedTimeoutHost = fenceHost;
      fenceHost.showTimeout();
      fenceHost.setBooting(false);
    }, CATALOG_TERMINAL_READY_TIMEOUT_MS);
  }
  function releaseRefreshFence(host: TerminalIntentHost): void {
    if (ownedFenceHost !== host) {
      return;
    }
    api.resetLifecycle(host);
    void api.drain();
  }

  const api = {
    bindHost(host: TerminalIntentHost): void {
      if (ownedHosts.length === 0) {
        rehydrate();
      }
      ownedHosts = [...ownedHosts.filter((bound) => bound !== host), host];
      void api.drain();
    },
    releaseHost(host: TerminalIntentHost): void {
      ownedHosts = ownedHosts.filter((bound) => bound !== host);
      // A fence outlives its opener only as a deadlock: nothing else can release it.
      if (ownedFenceHost === host) {
        api.resetLifecycle(host);
      }
      if (ownedHosts.length === 0) {
        clearRefreshTimer();
        ownedRefreshTimedOut = false;
        ownedTimeoutHost = null;
        rehydrate();
      }
    },
    get hasActions(): boolean {
      return ownedActions.length > 0;
    },
    get fenced(): boolean {
      return ownedRefreshPending;
    },
    get waitingForRefresh(): boolean {
      return ownedRefreshPending && !ownedRefreshTimedOut && ownedActions.length > 0;
    },
    refreshBeforeReconnect(
      host: TerminalIntentHost,
      isConnected: () => boolean,
      restore?: () => void,
      resume?: () => Promise<void>,
    ): void {
      const generation = host.currentGeneration();
      api.beginRefreshFence(host, generation);
      restore?.();
      const release = async () => {
        if (generation !== host.currentGeneration() || !isConnected()) {
          return;
        }
        // Retained streams recover under the fence before queued work uses their connection.
        await resume?.();
        if (generation === host.currentGeneration() && isConnected()) {
          releaseRefreshFence(host);
        }
      };
      void import("../../app/sw-refresh.runtime.ts")
        .then(({ refreshControlUiServiceWorker }) => refreshControlUiServiceWorker())
        .then((replacementActivated) => (replacementActivated ? undefined : release()), release);
    },
    beginRefreshFence(host: TerminalIntentHost, generation: number): void {
      ownedRefreshPending = true;
      ownedFenceHost = host;
      ownedFenceGeneration = generation;
      clearRefreshFailure();
      clearRefreshTimer();
      armRefreshTimer();
    },
    // Only the panel that opened the fence may drop it; another panel disposing
    // its tabs must not unblock a refresh it knows nothing about.
    resetLifecycle(host: TerminalIntentHost): void {
      if (ownedFenceHost !== null && ownedFenceHost !== host) {
        return;
      }
      clearRefreshTimer();
      ownedRefreshPending = false;
      ownedFenceHost = null;
      clearRefreshFailure();
    },
    canHandoff(source: Pick<TerminalPanelSessionState, "booting" | "tabs">): boolean {
      return (
        !source.booting &&
        !api.fenced &&
        !api.hasActions &&
        !source.tabs.some((tab) => tab.status === "connecting")
      );
    },
    /** Transfers view ownership before the destination binds, active tab last. */
    queueHandoff(
      source: Pick<TerminalPanelSessionState, "tabs" | "activeId" | "error">,
      client: TerminalGatewayClient | null,
    ): TerminalPanelSessionTab[] {
      const tabs = source.tabs.toSorted(
        (a, b) => Number(a.id === source.activeId) - Number(b.id === source.activeId),
      );
      discardRestoreActions();
      ownedActions.push(
        ...tabs.map((tab, index): TerminalHandoff => ({
          kind: "handoff",
          tab,
          client,
          error: index === tabs.length - 1 ? source.error : null,
        })),
      );
      persist();
      // The queue owns retained emulators; only live views follow source teardown.
      return source.tabs.filter((tab) => tab.status !== "exited");
    },
    async queue(
      action: TerminalPanelAction,
      options: { deferUntilHostChange?: boolean } = {},
    ): Promise<void> {
      let changed = action.kind !== "restore" && discardRestoreActions();
      const explicitIntentPending = ownedActions.some((pending) => pending.kind !== "restore");
      const key = JSON.stringify(action);
      if (
        !(action.kind === "restore" && explicitIntentPending) &&
        !ownedActions.some(
          (pending) => pending.kind !== "handoff" && JSON.stringify(pending) === key,
        )
      ) {
        ownedActions.push(action);
        changed = true;
      }
      if (changed) {
        persist();
      }
      // A session-route intent is persisted before its embedded panel mounts.
      // The shell's bottom-only panel must not claim it in that gap; the next
      // host binding drains it from the canonical document queue.
      if (options.deferUntilHostChange) {
        return;
      }
      armRefreshTimer();
      const host = readHost();
      if (ownedRefreshPending) {
        host?.publish();
      } else if (host && !host.hasTabs()) {
        host.setBooting(true);
      }
      await api.drain();
    },
    async drain(): Promise<void> {
      const host = readHost();
      if (ownedDrainScheduled || ownedActions.length === 0 || !host || !canRun(host)) {
        return;
      }
      ownedDrainScheduled = true;
      try {
        await host.bootQueue.enqueue(async (isCurrent) => {
          const action = ownedActions[0];
          if (!action || !isCurrent() || !canRun(host)) {
            return;
          }
          const completed = await execute(host, action, () => retireAction(action));
          if (!completed || !isCurrent()) {
            return;
          }
          retireAction(action);
          if (completed === "cancelled-restore" && readHost() === host) {
            host.cancelledRestoreCompleted();
          }
        });
      } finally {
        ownedDrainScheduled = false;
        const current = readHost();
        current?.publish();
        if (ownedActions.length > 0 && current && canRun(current)) {
          void api.drain();
        } else if (ownedActions.length === 0 && current && !current.hasTabs()) {
          current.setBooting(false);
        }
      }
    },
    // Closing a terminal drops the intents queued for it, but only the panel the
    // operator is actually looking at may do that to the shared queue.
    cancel(host: TerminalIntentHost): void {
      if (readHost() !== host) {
        return;
      }
      for (const action of ownedActions.splice(0)) {
        if (action.kind === "handoff" && action.tab.status === "exited") {
          disposeTerminalController(action.tab.controller, action.tab.host);
        }
      }
      persist();
      host.setBooting(false);
      clearRefreshFailure();
    },
  };

  rehydrate();

  return api;
}

/** Document-scoped owner; panels bind to it, they do not own copies. */
export const terminalIntentQueue = createTerminalIntentQueue();

/**
 * The durable intent a toggle implies, if any. Observers record it here rather
 * than handing the raw event to a panel that may not be mounted yet: a reload
 * between the request and that mount would otherwise lose it with no trace.
 */
export function terminalToggleIntent(
  event: Event,
  fallbackAgentId: string | null,
): TerminalPanelAction | null {
  const detail =
    event instanceof CustomEvent && typeof event.detail === "object" && event.detail !== null
      ? (event.detail as TerminalPanelToggleDetail)
      : null;
  if (!detail || detail.open === false) {
    return null;
  }
  const agentId = detail.agentId?.trim() || fallbackAgentId;
  if (detail.newSession === true) {
    return { kind: "open", agentId };
  }
  if (detail.terminalSessionId) {
    return {
      kind: "attach",
      sessionId: detail.terminalSessionId,
      agentOwned: detail.agentOwned ?? true,
    };
  }
  return detail.open === true ? { kind: "restore", agentId } : null;
}
