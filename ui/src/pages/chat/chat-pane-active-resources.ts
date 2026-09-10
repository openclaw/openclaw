import type { EnvironmentsListResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  bindBrowserRequestClient,
  listBrowserTabs,
} from "../../components/browser/browser-client.ts";
import type { BrowserTabSelection } from "../../components/browser/browser-target.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { readSessionChangedEvent } from "../../lib/sessions/reconcile.ts";
import {
  areUiSessionKeysEquivalent,
  uiSessionEventMatches,
  uiSessionRowMatchesSelectedChat,
} from "../../lib/sessions/session-key.ts";
import { resolveChatPaneDesktopTarget } from "./chat-pane-placement.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  openSlot,
  sidebarActivePanel,
  sidebarMainPanel,
  type SidebarLayout,
} from "./sidebar-layout.ts";

type ResourceSlot = "desktop" | "browser";
export type ActiveResourceOwner = {
  client: GatewayBrowserClient;
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
  commit: (layout: SidebarLayout) => void;
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

/** Read-only discovery belongs to the visible session, not to a global tool dock. */
export class ChatPaneActiveResources {
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
        sessionKey: string;
        agentId?: string;
        connectionEpoch: number;
        source: string | null;
      }
    | undefined;

  invalidate(): void {
    this.generation += 1;
    this.signature = undefined;
    this.pendingProbes = 0;
    this.reconciliation = undefined;
    this.reconciliationFailed = false;
    this.probeCurrent = undefined;
    this.requestProbeUpdate = undefined;
  }

  reconcileSession(
    payload: unknown,
    state: ChatPageHost,
    view: { requestUpdate: () => void; updated: () => Promise<unknown> },
  ): void {
    const changed = readSessionChangedEvent(payload);
    if (!changed || !uiSessionEventMatches(state, changed.key, changed.agentId)) {
      return;
    }
    // The roster owner coalesces/absorbs scheduled event refreshes. Sync its
    // post-event snapshot before releasing existing probe results, without
    // discarding them when only metadata changed.
    this.reconcile(async () => {
      const result = await state.sessions.refreshReplacement(
        scopedAgentParamsForSession(state, state.sessionKey).agentId,
      );
      if (
        !result?.sessions.some((row) =>
          uiSessionRowMatchesSelectedChat(state, row.key, state.sessionKey, row.agentId),
        )
      ) {
        // A filtered/paged roster may retain a cached selected row for display;
        // that row is not post-event evidence of resource ownership.
        return false;
      }
      view.requestUpdate();
      await view.updated();
      return true;
    });
  }

  /** Hold existing results, rather than discarding/reissuing them for every event. */
  reconcile(refresh: () => Promise<boolean>): void {
    const current = this.probeCurrent;
    if (
      (!this.pendingProbes && !this.reconciliationFailed && !this.reconciliation) ||
      !current?.()
    ) {
      return;
    }
    const retryDiscovery = this.pendingProbes === 0;
    const requestUpdate = this.requestProbeUpdate;
    const pending = Promise.resolve()
      .then(() => (current() ? refresh() : false))
      .catch(() => false);
    this.reconciliation = pending;
    this.reconciliationFailed = false;
    void pending.then((ok) => {
      if (this.reconciliation === pending) {
        this.reconciliationFailed = !ok;
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

  private async currentAfterReconciliation(current: () => boolean): Promise<boolean> {
    let pending: Promise<boolean> | undefined;
    while (current() && (pending = this.reconciliation)) {
      const ok = await pending;
      // A newer refresh owns the decision even if the one we awaited failed.
      if (this.reconciliation !== pending) {
        continue;
      }
      if (!ok) {
        return false;
      }
    }
    return current();
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
  ): string | null | undefined {
    if (this.desktop?.sessionKey !== sessionKey || this.desktop.agentId !== agentId) {
      return undefined;
    }
    return this.desktop.client === client && this.desktop.connectionEpoch === connectionEpoch
      ? this.desktop.source
      : null;
  }

  sync(owner: ActiveResourceOwner | null): void {
    if (!owner) {
      this.invalidate();
      // Retained panes must revalidate their automatic target before showing it again.
      if (this.desktop) {
        this.desktop.source = null;
      }
      return;
    }
    const signature = JSON.stringify([
      owner.sessionKey,
      owner.agentId,
      owner.connectionEpoch,
      owner.sessionId,
      owner.execNode,
      owner.archived === true,
      placementResourceIdentity(owner.placement),
      owner.desktopAvailable,
      owner.browserAvailable,
      owner.browserTab,
      owner.layout().resourceAutoOpenDismissed,
    ]);
    if (this.client === owner.client && this.signature === signature) {
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
        this.desktop.connectionEpoch !== owner.connectionEpoch
      ) {
        this.desktop = {
          ...this.desktop,
          client: owner.client,
          connectionEpoch: owner.connectionEpoch,
          source: null,
        };
      }
    }
    if (this.dismissed(owner.layout())) {
      this.desktop = undefined;
      return;
    }
    const current = () =>
      generation === this.generation && owner.isCurrent() && !this.dismissed(owner.layout());
    this.probeCurrent = current;
    this.requestProbeUpdate = owner.requestUpdate;
    // Independent probes: a broken browser route must not hide an available desktop.
    if (owner.desktopAvailable) {
      this.trackProbe(this.discoverDesktop(owner, current), generation);
    }
    if (owner.browserAvailable && owner.browserTab) {
      this.trackProbe(this.discoverBrowser(owner, owner.browserTab, current), generation);
    }
  }

  private dismissed(layout: SidebarLayout): boolean {
    // Older profiles already encode a deliberate minimized dock without the new marker.
    return (
      layout.resourceAutoOpenDismissed === true ||
      (layout.open === false && layout.columns.some((column) => column.panels.length > 0))
    );
  }

  private publishDesktop(owner: ActiveResourceOwner, source: string | null): void {
    const existing = owner
      .layout()
      .columns.some((column) => column.panels.some((panel) => panel.slot === "desktop"));
    // A manual open that won the discovery race owns its explicit target.
    if (!this.desktop && (source === null || existing)) {
      return;
    }
    const changed = this.desktop?.source !== source;
    this.desktop = {
      client: owner.client,
      sessionKey: owner.sessionKey,
      agentId: owner.agentId,
      connectionEpoch: owner.connectionEpoch,
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
    owner.commit(next);
  }

  private async discoverDesktop(owner: ActiveResourceOwner, current: () => boolean): Promise<void> {
    try {
      const { session } = await owner.client.request<{ session?: GatewaySessionRow }>(
        "sessions.describe",
        { key: owner.sessionKey, ...(owner.agentId ? { agentId: owner.agentId } : {}) },
      );
      if (!(await this.currentAfterReconciliation(current))) {
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
      if (!source || source === "gateway") {
        this.publishDesktop(owner, null);
        return;
      }
      const { environments } = await owner.client.request<EnvironmentsListResult>(
        "environments.list",
        {},
      );
      if (!(await this.currentAfterReconciliation(current))) {
        return;
      }
      const environment = environments.find((entry) => entry.id === source);
      if (!environment || environment.status !== "available" || environment.desktop !== true) {
        this.publishDesktop(owner, null);
        return;
      }
      if (
        environment.type === "worker" &&
        (environment.worker?.state !== "attached" ||
          !session.sessionId ||
          !environment.worker.attachedSessionIds.includes(session.sessionId))
      ) {
        this.publishDesktop(owner, null);
        return;
      }
      this.publishDesktop(owner, source);
    } catch {
      if (await this.currentAfterReconciliation(current)) {
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
      const snapshot = await listBrowserTabs(
        bindBrowserRequestClient(owner.client, selection.tab, current),
      );
      if (
        !(await this.currentAfterReconciliation(current)) ||
        !snapshot.running ||
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
