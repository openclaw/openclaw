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
import type {
  SessionCapability,
  SessionRowObservation,
} from "../../lib/sessions/session-capability.ts";
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
  sessions: Pick<SessionCapability, "describe">;
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

type ResourceIdentitySource = Pick<
  GatewaySessionRow,
  "sessionId" | "execNode" | "archived" | "placement"
>;

function resourceIdentityForSession(session: ResourceIdentitySource | undefined): string {
  const placement = session?.placement;
  const runner = placement?.state === "active" ? placement.runner : undefined;
  // Ack cursors, disk observations and timestamps advance during ordinary work;
  // they do not replace the resource or revoke an in-flight discovery owner.
  return JSON.stringify([
    session?.sessionId,
    session?.execNode,
    session?.archived === true,
    placement
      ? [
          placement.state,
          placement.generation,
          "environmentId" in placement ? placement.environmentId : undefined,
          "activeOwnerEpoch" in placement ? placement.activeOwnerEpoch : undefined,
          "providerId" in placement ? placement.providerId : undefined,
          "profileId" in placement ? placement.profileId : undefined,
          runner?.kind,
          runner?.deviceId,
          runner?.status,
        ]
      : null,
  ]);
}

function hasResourceSlot(layout: SidebarLayout, slot: ResourceSlot): boolean {
  return layout.columns.some((column) => column.panels.some((panel) => panel.slot === slot));
}

/** Read-only discovery belongs to the visible session, not to a global tool dock. */
export class ChatPaneActiveResources {
  private owner: ActiveResourceOwner | null = null;
  private descriptorRead:
    | {
        observation: SessionRowObservation;
        identity: string;
        promise: Promise<GatewaySessionRow | null>;
      }
    | undefined;
  private signature: string | undefined;
  private client: GatewayBrowserClient | undefined;
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
            sessions: state.sessions,
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
    this.signature = undefined;
  }

  reconcileObservation(view: { requestUpdate: () => void; updated: () => Promise<unknown> }): void {
    const owner = this.owner;
    if (!owner?.isCurrent() || !owner.observation.isCurrent()) {
      return;
    }
    const layout = owner.layout();
    const desktopDiscovery =
      owner.desktopAvailable && (this.desktop !== undefined || !hasResourceSlot(layout, "desktop"));
    const browserDiscovery =
      !this.dismissed(layout) && owner.browserAvailable && owner.browserTab !== undefined;
    if (!desktopDiscovery && !browserDiscovery) {
      return;
    }
    // Do not expose a resource while its assignment is being revalidated.
    this.invalidate();
    this.descriptorRead = undefined;
    void this.readSession(owner).then(view.requestUpdate, () => {});
  }

  private readSession(owner: ActiveResourceOwner): Promise<GatewaySessionRow | null> {
    const previous = this.descriptorRead;
    const identity = resourceIdentityForSession(owner);
    if (previous?.observation === owner.observation && previous.identity === identity) {
      return previous.promise;
    }
    const read = {
      observation: owner.observation,
      identity,
      promise: Promise.resolve<GatewaySessionRow | null>(null),
    };
    read.promise = (async () => {
      const reconcile = owner.observation.captureReconcile();
      const { session } = await owner.sessions.describe(
        { key: owner.sessionKey, ...(owner.agentId ? { agentId: owner.agentId } : {}) },
        { client: owner.client },
      );
      const outcome = reconcile(session ?? undefined);
      // An overlapping row change can wait for the next refresh; discovery is read-only.
      return outcome.status === "current" ? outcome.row : null;
    })().finally(() => {
      if (this.descriptorRead === read) {
        this.descriptorRead = undefined;
      }
    });
    this.descriptorRead = read;
    return read.promise;
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
    this.client = owner.client;
    this.signature = signature;
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
    const desktopAlreadyPresent = hasResourceSlot(owner.layout(), "desktop");
    if (this.dismissed(owner.layout()) && (!this.desktop || !desktopAlreadyPresent)) {
      this.desktop = undefined;
      return;
    }
    const current = () =>
      this.signature === signature &&
      this.descriptorRead === undefined &&
      owner.isCurrent() &&
      (!this.dismissed(owner.layout()) ||
        (this.desktop !== undefined && hasResourceSlot(owner.layout(), "desktop")));
    // Independent probes: a broken browser route must not hide an available desktop.
    // Existing manual panels own their reads, including dormant retained tabs.
    if (owner.desktopAvailable && (this.desktop || !desktopAlreadyPresent)) {
      void this.discoverDesktop(owner, current);
    }
    if (!this.dismissed(owner.layout()) && owner.browserAvailable && owner.browserTab) {
      void this.discoverBrowser(owner, owner.browserTab, current);
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
    const existing = hasResourceSlot(owner.layout(), "desktop");
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
    if (hasResourceSlot(layout, slot)) {
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
      // Shared reads must still describe this pane's assigned resource before opening it.
      if (
        !current() ||
        (session && resourceIdentityForSession(session) !== resourceIdentityForSession(owner))
      ) {
        return;
      }
      if (
        !session ||
        !areUiSessionKeysEquivalent(session.key, owner.sessionKey) ||
        session.archived
      ) {
        this.publishDesktop(owner, null);
        return;
      }
      // The default gateway desktop is shared, not session-owned. Only an explicit
      // assignment can justify discovery; never infer ownership from global availability.
      const source = resolveChatPaneDesktopTarget(session);
      if (
        !source ||
        source === "gateway" ||
        (desktopSourceForEnvironment({ id: source }).kind === "environment" && !session.sessionId)
      ) {
        this.publishDesktop(owner, null);
        return;
      }
      const target = await loadDesktopEnvironments(owner.client, {
        target: Promise.resolve(source),
        isCurrent: current,
        recoverToPicker: false,
      });
      if (!current()) {
        return;
      }
      const environment = target?.environments.find((entry) => entry.id === source);
      if (
        !environment ||
        environment.status !== "available" ||
        environment.desktop !== true ||
        (environment.type === "worker" &&
          (environment.worker?.state !== "attached" ||
            !session.sessionId ||
            !environment.worker.attachedSessionIds.includes(session.sessionId)))
      ) {
        this.publishDesktop(owner, null);
        return;
      }
      this.publishDesktop(owner, source);
    } catch {
      if (current()) {
        this.publishDesktop(owner, null);
      }
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
      if (
        !session ||
        session.archived ||
        !current() ||
        resourceIdentityForSession(session) !== resourceIdentityForSession(owner)
      ) {
        return;
      }
      const snapshot = await listBrowserTabs(
        bindBrowserRequestClient(owner.client, selection.tab, current),
      );
      if (
        !current() ||
        !snapshot?.running ||
        !snapshot.tabs.some(
          (tab) => tab.targetId === selection.tab.targetId && !tab.urlUnavailableReason,
        )
      ) {
        return;
      }
      // No /start, /tabs/open, focus, or unscoped default-browser probe.
      this.reveal(owner, "browser");
    } catch {
      // Historical result cards alone cannot prove the tab still exists.
    }
  }
}
