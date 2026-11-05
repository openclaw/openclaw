import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  bindBrowserRequestClient,
  type BrowserRequestClient,
  type BrowserPageMetrics,
  type BrowserPanelTab,
  type BrowserDashboardTarget,
} from "./browser-client.ts";
import type { BrowserRoute, BrowserTabTarget } from "./browser-target.ts";

export interface BrowserPanelHost {
  readonly client: GatewayBrowserClient | null;
  readonly sessionKey: string;
  readonly sessionTabs?: readonly BrowserTabTarget[];
  readonly available: boolean;
  readonly remoteAvailable?: boolean;
  readonly fixedTab?: BrowserTabTarget;
  readonly dashboardTarget?: BrowserDashboardTarget;
  readonly resourceBasePath: string;
  readonly authToken: string | null;
  readonly isConnected: boolean;
  readonly renderRoot: HTMLElement | DocumentFragment;
  readonly updateComplete: Promise<boolean>;
  browserPanelIsOpen(): boolean;
}

type BrowserPanelInvocation = {
  readonly client: BrowserRequestClient;
  epoch: number;
  readonly id: number;
  isCurrent(): boolean;
};

export type BrowserPanelSnapshotOutcome = "accepted" | "rejected" | "failed";

/** Synchronous admission for tab snapshots, navigation, capture and input operations. */
export function createBrowserPanelOperations(host: BrowserPanelHost) {
  let lifecycleEpoch = 0;
  let route: BrowserRoute | undefined;
  let scope:
    | {
        gateway: GatewayBrowserClient;
        client: BrowserRequestClient;
        dashboardKey: string | undefined;
        sessionKey: string;
      }
    | undefined;
  let requestedMutation = 0;
  let requestedCapture = 0;
  let requestedInspection = 0;
  let capturePending = false;
  const navigationQueues = new WeakMap<BrowserRequestClient, Map<string, Promise<unknown>>>();
  const navigationCommits = new WeakMap<BrowserRequestClient, Set<string>>();

  const operations = {
    get route(): BrowserRoute | undefined {
      return route;
    },
    get epoch(): number {
      return lifecycleEpoch;
    },

    get hasPendingCapture(): boolean {
      return capturePending;
    },

    captureClient(): BrowserRequestClient | null {
      const gateway = host.client;
      const dashboardKey = JSON.stringify(host.dashboardTarget);
      const sessionKey = host.dashboardTarget ? "" : host.sessionKey.trim();
      if (
        !(host.remoteAvailable ?? host.available) ||
        !gateway ||
        !host.isConnected ||
        !host.browserPanelIsOpen()
      ) {
        return null;
      }
      if (
        scope?.gateway !== gateway ||
        scope.dashboardKey !== dashboardKey ||
        scope.sessionKey !== sessionKey
      ) {
        const client = bindBrowserRequestClient(
          gateway,
          route,
          () =>
            scope?.client === client &&
            scope.gateway === host.client &&
            JSON.stringify(host.dashboardTarget) === dashboardKey &&
            (host.dashboardTarget ? "" : host.sessionKey.trim()) === sessionKey &&
            (host.remoteAvailable ?? host.available) &&
            host.isConnected &&
            host.browserPanelIsOpen(),
          host.dashboardTarget,
          // References change the list scope, not ownership of captures or streams.
          sessionKey
            ? () => ({
                sessionKey,
                referencedTabs: host.sessionTabs ?? [],
              })
            : undefined,
        );
        scope = { gateway, client, dashboardKey, sessionKey };
      }
      return scope.client;
    },

    resetRoute(nextRoute?: BrowserRoute): void {
      operations.invalidate();
      route = nextRoute;
      scope = undefined;
    },

    isLive(epoch: number, client?: BrowserRequestClient): boolean {
      return (
        host.isConnected &&
        host.available &&
        host.browserPanelIsOpen() &&
        lifecycleEpoch === epoch &&
        scope?.dashboardKey === JSON.stringify(host.dashboardTarget) &&
        (scope?.sessionKey ?? "") === (host.dashboardTarget ? "" : host.sessionKey.trim()) &&
        (client === undefined || (scope?.gateway === host.client && scope.client === client))
      );
    },

    invalidate(): void {
      lifecycleEpoch += 1;
      capturePending = false;
      operations.invalidateInspection();
    },

    invalidateInspection(): void {
      requestedInspection += 1;
    },

    beginMutation(client: BrowserRequestClient): BrowserPanelInvocation {
      // A mutation owns loading before its remote tab or new document exists.
      // Invalidate the previous capture without discarding its visible screenshot.
      requestedCapture += 1;
      capturePending = false;
      requestedMutation += 1;
      return operations.beginSnapshot(client);
    },

    /** A committed document still needs its first owner-authoritative screenshot. */
    hasUnreconciledNavigation(
      client: BrowserRequestClient | null,
      targetId: string | null,
    ): boolean {
      if (!client || !targetId) {
        return false;
      }
      return navigationCommits.get(client)?.has(targetId) ?? false;
    },

    hasPendingNavigation(client: BrowserRequestClient | null, targetId: string | null): boolean {
      return Boolean(
        client &&
        targetId &&
        (navigationQueues.get(client)?.has(targetId) ||
          operations.hasUnreconciledNavigation(client, targetId)),
      );
    },

    markNavigationCommitted(client: BrowserRequestClient, targetId: string): void {
      let commits = navigationCommits.get(client);
      if (!commits) {
        commits = new Set();
        navigationCommits.set(client, commits);
      }
      commits.add(targetId);
    },

    forgetNavigation(client: BrowserRequestClient, targetId: string): void {
      const commits = navigationCommits.get(client);
      commits?.delete(targetId);
      if (commits?.size === 0) {
        navigationCommits.delete(client);
      }
    },

    retainTabSnapshot(client: BrowserRequestClient, tabs: BrowserPanelTab[]): BrowserPanelTab[] {
      const commits = navigationCommits.get(client);
      if (!commits) {
        return tabs;
      }
      const liveTargetIds = new Set(tabs.map((tab) => tab.id));
      for (const targetId of commits.keys()) {
        if (!liveTargetIds.has(targetId)) {
          commits.delete(targetId);
        }
      }
      if (commits.size === 0) {
        navigationCommits.delete(client);
      }
      return tabs;
    },

    capturedTabs(
      tabs: BrowserPanelTab[],
      targetId: string,
      metrics: BrowserPageMetrics | null,
      screenshotUrl: string,
    ): BrowserPanelTab[] {
      const tab = tabs.find((entry) => entry.id === targetId);
      if (!tab) {
        return tabs;
      }
      const title = metrics?.title ?? tab.title;
      const url = metrics?.url || screenshotUrl || tab.url;
      return title === tab.title && url === tab.url && !tab.urlUnavailableReason
        ? tabs
        : tabs.map((entry) =>
            entry.id === targetId
              ? { ...entry, title, url, urlUnavailableReason: undefined }
              : entry,
          );
    },

    /** Remote navigations for one gateway tab must commit in user-intent order. */
    async queueNavigation<T>(
      client: BrowserRequestClient,
      targetId: string,
      navigate: () => Promise<T>,
    ): Promise<T> {
      let queues = navigationQueues.get(client);
      if (!queues) {
        queues = new Map();
        navigationQueues.set(client, queues);
      }
      const previous = queues.get(targetId);
      const current = previous ? previous.then(navigate, navigate) : navigate();
      queues.set(targetId, current);
      try {
        return await current;
      } finally {
        if (queues.get(targetId) === current) {
          queues.delete(targetId);
          if (queues.size === 0) {
            navigationQueues.delete(client);
          }
        }
      }
    },

    /** Passive refreshes never revoke ownership of an in-flight navigation. */
    beginSnapshot(client: BrowserRequestClient): BrowserPanelInvocation {
      const invocation: BrowserPanelInvocation = {
        client,
        epoch: lifecycleEpoch,
        id: requestedMutation,
        isCurrent: () =>
          operations.isLive(invocation.epoch, client) && invocation.id === requestedMutation,
      };
      return invocation;
    },

    acceptSnapshot(
      invocation: BrowserPanelInvocation,
      currentTargetId: string | null,
      snapshotTargetId: string | null,
    ): boolean {
      if (
        !operations.isLive(invocation.epoch, invocation.client) ||
        (!invocation.isCurrent() && snapshotTargetId !== currentTargetId)
      ) {
        return false;
      }
      // Same-tab refreshes are best effort; input still checks the live document at dispatch.
      return true;
    },

    /** A superseded open may reconcile its created tab, but never own the selected view. */
    survivingInvocation(
      superseded: BrowserPanelInvocation,
      client: BrowserRequestClient,
    ): () => boolean {
      const epoch = lifecycleEpoch;
      const invocationId = requestedMutation;
      return () =>
        operations.isLive(epoch, client) &&
        invocationId === requestedMutation &&
        (invocationId !== superseded.id || epoch !== superseded.epoch);
    },

    beginCapture(
      client: BrowserRequestClient,
      targetId: string,
      getActiveTargetId: () => string | null,
      epoch = lifecycleEpoch,
    ): (() => boolean) | null {
      if (!operations.isLive(epoch, client) || getActiveTargetId() !== targetId) {
        return null;
      }
      const captureId = ++requestedCapture;
      capturePending = true;
      return () =>
        operations.isLive(epoch, client) &&
        getActiveTargetId() === targetId &&
        captureId === requestedCapture;
    },

    completeCapture(): void {
      capturePending = false;
    },

    beginInspection(client: BrowserRequestClient, isTargetCurrent: () => boolean): () => boolean {
      const epoch = lifecycleEpoch;
      const inspectionId = ++requestedInspection;
      return () =>
        operations.isLive(epoch, client) &&
        inspectionId === requestedInspection &&
        isTargetCurrent();
    },
  };
  return operations;
}

export type BrowserPanelOperations = ReturnType<typeof createBrowserPanelOperations>;
