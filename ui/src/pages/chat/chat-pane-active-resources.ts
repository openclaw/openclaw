import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { isBrowserPanelAvailable, isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import {
  bindBrowserRequestClient,
  listBrowserTabs,
} from "../../components/browser/browser-client.ts";
import type { BrowserTabSelection } from "../../components/browser/browser-target.ts";
import {
  desktopSourceForEnvironment,
  loadDesktopEnvironments,
} from "../../components/desktop/desktop-source.ts";
import { latestBrowserTabCards } from "../../lib/chat/browser-tab-preview.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import type { SessionRowObservation } from "../../lib/sessions/session-capability.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { resolveChatPaneDesktopTarget } from "./chat-pane-placement.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  openSlot,
  sidebarActivePanel,
  sidebarMainPanel,
  sidebarSidePanels,
  type SidebarLayout,
} from "./sidebar-layout.ts";

type ResourceSlot = "desktop" | "browser";
export type ActiveResourceOwner = {
  client: GatewayBrowserClient;
  observation: SessionRowObservation;
  sessionKey: string;
  agentId?: string;
  connectionEpoch: number;
  desktopAvailable: boolean;
  browserAvailable: boolean;
  placement: GatewaySessionRow["placement"];
  sessionId?: GatewaySessionRow["sessionId"];
  execNode?: GatewaySessionRow["execNode"];
  archived?: boolean;
  browserTab?: BrowserTabSelection;
  layout: () => SidebarLayout;
  commit: (layout: SidebarLayout, resource: ResourceSlot) => void;
  requestUpdate: () => void;
  isCurrent: () => boolean;
};

function placementResourceIdentity(placement: GatewaySessionRow["placement"]) {
  if (!placement) {
    return null;
  }
  const runner = placement.state === "active" ? placement.runner : undefined;
  // Ack cursors, disk observations and timestamps advance during ordinary work;
  // they do not replace the resource or revoke an in-flight discovery owner.
  return [
    placement.state,
    placement.generation,
    "environmentId" in placement ? placement.environmentId : undefined,
    "activeOwnerEpoch" in placement ? placement.activeOwnerEpoch : undefined,
    "providerId" in placement ? placement.providerId : undefined,
    "profileId" in placement ? placement.profileId : undefined,
    runner?.kind,
    runner?.deviceId,
    runner?.status,
  ];
}

type ResourceIdentitySource = Pick<
  GatewaySessionRow,
  "sessionId" | "execNode" | "archived" | "placement"
>;

function resourceIdentityForSession(session: ResourceIdentitySource | undefined): string {
  return JSON.stringify([
    session?.sessionId,
    session?.execNode,
    session?.archived === true,
    placementResourceIdentity(session?.placement),
  ]);
}

/** Read-only discovery belongs to the visible session, not to a global tool dock. */
export class ChatPaneActiveResources {
  private owner: ActiveResourceOwner | null = null;
  private descriptorRead:
    | {
        observation: SessionRowObservation;
        current: () => boolean;
        promise: Promise<GatewaySessionRow | null>;
      }
    | undefined;
  private generation = 0;
  private signature: string | undefined;
  private client: GatewayBrowserClient | undefined;
  private pendingProbes = 0;
  private reconciliation: Promise<boolean> | undefined;
  private reconciliationFailed = false;
  private probeCurrent: (() => boolean) | undefined;
  private requestProbeUpdate: (() => void) | undefined;
  private desktop:
    | {
        client: GatewayBrowserClient;
        observation: SessionRowObservation;
        sessionKey: string;
        agentId?: string;
        connectionEpoch: number;
        source: string | null;
        resourceIdentity: string;
      }
    | undefined;

  syncPane(view: {
    state: () => ChatPageHost | undefined;
    observation: () => SessionRowObservation | null;
    gateway: ApplicationGatewaySnapshot;
    isConnected: () => boolean;
    isPresented: () => boolean;
    commit: (layout: SidebarLayout, resource: ResourceSlot) => void;
    requestUpdate: () => void;
  }): void {
    const state = view.state();
    const client = state?.client;
    const sessionKey = state?.sessionKey;
    const connectionEpoch = state?.connectionEpoch;
    const agentId = state
      ? scopedAgentParamsForSession(state, state.sessionKey).agentId
      : undefined;
    const observation = view.observation();
    const session = observation?.row ?? undefined;
    // Keyboard focus may move to another split pane without hiding this resource.
    this.sync(
      state &&
        client &&
        sessionKey &&
        state.connected &&
        observation?.isCurrent() &&
        view.isPresented() &&
        !parseCatalogSessionKey(sessionKey)
        ? {
            client,
            observation,
            sessionKey,
            agentId,
            connectionEpoch: state.connectionEpoch,
            desktopAvailable: isDesktopPanelAvailable(view.gateway),
            browserAvailable: isBrowserPanelAvailable(view.gateway),
            placement: session?.placement,
            sessionId: session?.sessionId,
            execNode: session?.execNode,
            archived: session?.archived,
            browserTab: [
              ...latestBrowserTabCards(state.chatMessages, state.chatToolMessages).values(),
            ].at(-1),
            layout: () => state.sidebarLayout,
            // Discovery is not a saved layout preference. Reload must validate again
            // before mounting a resource; explicit UI actions still persist normally.
            commit: (layout, resource) => view.commit(layout, resource),
            requestUpdate: () => view.requestUpdate(),
            isCurrent: () =>
              view.isConnected() &&
              view.state() === state &&
              state.client === client &&
              state.sessionKey === sessionKey &&
              scopedAgentParamsForSession(state, state.sessionKey).agentId === agentId &&
              state.connectionEpoch === connectionEpoch &&
              state.connected &&
              view.observation() === observation &&
              observation.isCurrent() &&
              resourceIdentityForSession(observation.row ?? undefined) ===
                resourceIdentityForSession(session) &&
              view.isPresented(),
          }
        : null,
    );
  }

  invalidate(): void {
    this.generation += 1;
    this.signature = undefined;
    this.pendingProbes = 0;
    this.reconciliation = undefined;
    this.reconciliationFailed = false;
    this.probeCurrent = undefined;
    this.requestProbeUpdate = undefined;
  }

  reconcileObservation(view: { requestUpdate: () => void; updated: () => Promise<unknown> }): void {
    const owner = this.owner;
    if (!owner?.isCurrent() || !owner.observation.isCurrent()) {
      return;
    }
    const layout = owner.layout();
    const desktopDiscovery =
      owner.desktopAvailable &&
      (this.desktop !== undefined ||
        !layout.columns.some((column) => column.panels.some((panel) => panel.slot === "desktop")));
    const browserDiscovery =
      !this.dismissed(layout) && owner.browserAvailable && owner.browserTab !== undefined;
    if (!desktopDiscovery && !browserDiscovery) {
      return;
    }
    // The pane's row observation admits descriptor reads without changing the
    // foreground roster query. Metadata refreshes hold existing inventory work.
    this.reconcile(async () => {
      await this.readSession(owner);
      view.requestUpdate();
      await view.updated();
      return owner.observation.isCurrent();
    });
  }

  private readSession(owner: ActiveResourceOwner): Promise<GatewaySessionRow | null> {
    const previous = this.descriptorRead;
    if (previous?.observation === owner.observation && previous.current()) {
      return previous.promise;
    }
    const generation = this.generation;
    const current = () =>
      generation === this.generation && owner.isCurrent() && owner.observation.isCurrent();
    const read = {
      observation: owner.observation,
      current,
      promise: Promise.resolve<GatewaySessionRow | null>(null),
    };
    read.promise = (async () => {
      while (current()) {
        const reconcile = owner.observation.captureReconcile();
        const { session } = await owner.client.request<{ session?: GatewaySessionRow }>(
          "sessions.describe",
          { key: owner.sessionKey, ...(owner.agentId ? { agentId: owner.agentId } : {}) },
        );
        if (!current()) {
          return null;
        }
        const outcome = reconcile(session);
        if (outcome.status === "current") {
          return outcome.row;
        }
        if (outcome.status === "retired") {
          return null;
        }
        // Events during the read share this flight and require one fresh receipt.
      }
      return null;
    })().finally(() => {
      if (this.descriptorRead === read) {
        this.descriptorRead = undefined;
      }
    });
    this.descriptorRead = read;
    return read.promise;
  }

  /** Hold existing results, rather than discarding/reissuing them for every event. */
  reconcile(refresh: () => Promise<boolean>): void {
    const current = this.probeCurrent;
    if (!current?.()) {
      return;
    }
    const retryDiscovery = this.reconciliationFailed && this.pendingProbes === 0;
    const requestUpdate = this.requestProbeUpdate;
    const pending = Promise.resolve()
      .then(() => (current() ? refresh() : false))
      .catch(() => false);
    this.reconciliation = pending;
    this.reconciliationFailed = false;
    void pending.then((ok) => {
      if (this.reconciliation === pending) {
        this.reconciliationFailed = !ok;
        if (!ok && this.desktop) {
          this.desktop.source = null;
          requestUpdate?.();
        }
        if (ok) {
          this.reconciliation = undefined;
          if (retryDiscovery && current() && this.pendingProbes === 0) {
            // A later successful event refresh may retry a probe discarded on
            // reconciliation failure, even when resource identity is unchanged.
            this.signature = undefined;
            requestUpdate?.();
          }
        }
      }
    });
  }

  private async afterReconciliation<T>(
    current: () => boolean,
    action: () => T,
  ): Promise<T | undefined> {
    let pending: Promise<boolean> | undefined;
    while (current() && (pending = this.reconciliation)) {
      const ok = await pending;
      // A newer refresh owns the decision even if the one we awaited failed.
      if (this.reconciliation !== pending) {
        continue;
      }
      if (!ok) {
        return undefined;
      }
    }
    // Ownership and publication must share a turn: another event can retire the
    // pane or start a newer refresh before an awaiting caller resumes.
    return current() ? action() : undefined;
  }

  private trackProbe(probe: Promise<void>, generation: number): void {
    this.pendingProbes += 1;
    void probe.finally(() => {
      if (this.generation === generation) {
        this.pendingProbes -= 1;
      }
    });
  }

  desktopSource(
    client: GatewayBrowserClient | null,
    sessionKey: string,
    agentId: string | undefined,
    connectionEpoch: number,
    session: ResourceIdentitySource | undefined,
  ): string | null | undefined {
    if (this.desktop?.sessionKey !== sessionKey || this.desktop.agentId !== agentId) {
      return undefined;
    }
    return this.desktop.client === client &&
      this.desktop.observation.isCurrent() &&
      this.desktop.connectionEpoch === connectionEpoch &&
      this.desktop.resourceIdentity === resourceIdentityForSession(session)
      ? this.desktop.source
      : null;
  }

  sync(owner: ActiveResourceOwner | null): void {
    const previousOwner = this.owner;
    this.owner = owner;
    if (!owner) {
      this.invalidate();
      // The Desktop panel owns its hidden-view retention timer. Its observed
      // session and connection still fence this source while the pane is hidden.
      return;
    }
    const identity = resourceIdentityForSession(owner);
    const signature = JSON.stringify([
      owner.sessionKey,
      owner.agentId,
      owner.connectionEpoch,
      identity,
      owner.desktopAvailable,
      owner.browserAvailable,
      owner.browserTab,
      owner.layout().resourceAutoOpenDismissed,
    ]);
    if (
      this.client === owner.client &&
      this.signature === signature &&
      previousOwner?.observation === owner.observation
    ) {
      return;
    }
    if (this.reconciliationFailed || (this.probeCurrent && !this.probeCurrent())) {
      // A failed refresh fences its old generation, not a later authoritative identity.
      this.reconciliation = undefined;
      this.reconciliationFailed = false;
    }
    this.client = owner.client;
    this.signature = signature;
    const generation = ++this.generation;
    this.pendingProbes = 0;
    if (this.desktop) {
      if (this.desktop.sessionKey !== owner.sessionKey || this.desktop.agentId !== owner.agentId) {
        this.desktop = undefined;
      } else if (
        this.desktop.client !== owner.client ||
        this.desktop.connectionEpoch !== owner.connectionEpoch ||
        this.desktop.resourceIdentity !== identity
      ) {
        this.desktop = {
          ...this.desktop,
          client: owner.client,
          connectionEpoch: owner.connectionEpoch,
          resourceIdentity: identity,
          source: null,
        };
      }
    }
    const desktopAlreadyPresent = owner
      .layout()
      .columns.some((column) => column.panels.some((panel) => panel.slot === "desktop"));
    if (this.dismissed(owner.layout()) && (!this.desktop || !desktopAlreadyPresent)) {
      this.desktop = undefined;
      return;
    }
    const current = () =>
      generation === this.generation &&
      owner.isCurrent() &&
      (!this.dismissed(owner.layout()) ||
        (this.desktop !== undefined &&
          owner
            .layout()
            .columns.some((column) => column.panels.some((panel) => panel.slot === "desktop"))));
    this.probeCurrent = current;
    this.requestProbeUpdate = owner.requestUpdate;
    // Independent probes: a broken browser route must not hide an available desktop.
    // Existing manual panels own their reads, including dormant retained tabs.
    if (owner.desktopAvailable && (this.desktop || !desktopAlreadyPresent)) {
      this.trackProbe(this.discoverDesktop(owner, current), generation);
    }
    if (!this.dismissed(owner.layout()) && owner.browserAvailable && owner.browserTab) {
      this.trackProbe(this.discoverBrowser(owner, owner.browserTab, current), generation);
    }
  }

  private dismissed(layout: SidebarLayout): boolean {
    // Older profiles already encode a deliberate minimized dock without the new marker.
    return (
      layout.resourceAutoOpenDismissed === true ||
      (layout.open === false &&
        sidebarSidePanels(layout).some((panel) => panel.slot !== "conversation"))
    );
  }

  private publishDesktop(owner: ActiveResourceOwner, source: string | null): void {
    const existing = owner
      .layout()
      .columns.some((column) => column.panels.some((panel) => panel.slot === "desktop"));
    if (this.dismissed(owner.layout()) && !existing) {
      return;
    }
    // A manual open that won the discovery race owns its explicit target.
    if (!this.desktop && (source === null || existing)) {
      return;
    }
    const changed = this.desktop?.source !== source;
    this.desktop = {
      client: owner.client,
      observation: owner.observation,
      sessionKey: owner.sessionKey,
      agentId: owner.agentId,
      connectionEpoch: owner.connectionEpoch,
      resourceIdentity: resourceIdentityForSession(owner),
      source,
    };
    if (source !== null) {
      this.reveal(owner, "desktop");
    }
    if (changed) {
      owner.requestUpdate();
    }
  }

  private reveal(owner: ActiveResourceOwner, slot: ResourceSlot): void {
    const layout = owner.layout();
    if (this.dismissed(layout)) {
      return;
    }
    // Existing tabs (including minimized ones) are user-owned. Never reselect them.
    if (layout.columns.some((column) => column.panels.some((panel) => panel.slot === slot))) {
      return;
    }
    const next = openSlot(layout, slot);
    // Add to the same dock without stealing an already-visible selection or expanding chat.
    if (layout.open && sidebarActivePanel(layout)) {
      next.columns[0]!.activePanelId = layout.columns[0]!.activePanelId;
    }
    if (
      sidebarMainPanel(layout)?.slot !== undefined &&
      sidebarMainPanel(layout)?.slot !== "conversation"
    ) {
      next.open = layout.open;
    }
    next.expanded = layout.expanded;
    next.expandedSide = layout.expandedSide;
    owner.commit(next, slot);
  }

  private async discoverDesktop(owner: ActiveResourceOwner, current: () => boolean): Promise<void> {
    try {
      const session = await this.readSession(owner);
      const source = await this.afterReconciliation(current, () => {
        if (
          !session ||
          !areUiSessionKeysEquivalent(session.key, owner.sessionKey) ||
          session.archived
        ) {
          this.publishDesktop(owner, null);
          return undefined;
        }
        // The default gateway desktop is shared, not session-owned. Only an explicit
        // assignment can justify discovery; never infer ownership from global availability.
        const assignedSource = resolveChatPaneDesktopTarget(session);
        if (
          !assignedSource ||
          assignedSource === "gateway" ||
          (desktopSourceForEnvironment({ id: assignedSource }).kind === "environment" &&
            !session.sessionId)
        ) {
          this.publishDesktop(owner, null);
          return undefined;
        }
        return assignedSource;
      });
      if (!source) {
        return;
      }
      const target = await loadDesktopEnvironments(owner.client, {
        target: Promise.resolve(source),
        isCurrent: current,
        recoverToPicker: false,
      });
      await this.afterReconciliation(current, () => {
        const environment = target?.environments.find((entry) => entry.id === source);
        if (!environment || environment.status !== "available" || environment.desktop !== true) {
          this.publishDesktop(owner, null);
          return;
        }
        if (
          environment.type === "worker" &&
          (environment.worker?.state !== "attached" ||
            !session?.sessionId ||
            !environment.worker.attachedSessionIds.includes(session.sessionId))
        ) {
          this.publishDesktop(owner, null);
          return;
        }
        this.publishDesktop(owner, source);
      });
    } catch {
      await this.afterReconciliation(current, () => {
        this.publishDesktop(owner, null);
      });
      // Unavailable inventory is not evidence of a live resource. Manual opening remains available.
    }
  }

  private async discoverBrowser(
    owner: ActiveResourceOwner,
    selection: BrowserTabSelection,
    current: () => boolean,
  ): Promise<void> {
    try {
      const session = await this.readSession(owner);
      if (!session || session.archived) {
        return;
      }
      const snapshot = await this.afterReconciliation(current, () =>
        listBrowserTabs(bindBrowserRequestClient(owner.client, selection.tab, current)),
      );
      await this.afterReconciliation(current, () => {
        if (
          !snapshot?.running ||
          !snapshot.tabs.some(
            (tab) => tab.targetId === selection.tab.targetId && !tab.urlUnavailableReason,
          )
        ) {
          return;
        }
        // No /start, /tabs/open, focus, or unscoped default-browser probe.
        this.reveal(owner, "browser");
      });
    } catch {
      // Historical result cards alone cannot prove the tab still exists.
    }
  }
}
