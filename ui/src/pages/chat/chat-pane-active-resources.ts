import type { EnvironmentsListResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  bindBrowserRequestClient,
  listBrowserTabs,
} from "../../components/browser/browser-client.ts";
import type { BrowserTabSelection } from "../../components/browser/browser-target.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { resolveChatPaneDesktopTarget } from "./chat-pane-placement.ts";
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
  browserTab?: BrowserTabSelection;
  layout: () => SidebarLayout;
  commit: (layout: SidebarLayout) => void;
  requestUpdate: () => void;
  isCurrent: () => boolean;
};

/** Read-only discovery belongs to the visible session, not to a global tool dock. */
export class ChatPaneActiveResources {
  private generation = 0;
  private signature: string | undefined;
  private client: GatewayBrowserClient | undefined;
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
      owner.placement,
      owner.desktopAvailable,
      owner.browserAvailable,
      owner.browserTab,
      owner.layout().resourceAutoOpenDismissed,
    ]);
    if (this.client === owner.client && this.signature === signature) {
      return;
    }
    this.client = owner.client;
    this.signature = signature;
    const generation = ++this.generation;
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
    // Independent probes: a broken browser route must not hide an available desktop.
    if (owner.desktopAvailable) {
      void this.discoverDesktop(owner, current);
    }
    if (owner.browserAvailable && owner.browserTab) {
      void this.discoverBrowser(owner, owner.browserTab, current);
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
      if (!current()) {
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
      if (!current()) {
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
      const snapshot = await listBrowserTabs(
        bindBrowserRequestClient(owner.client, selection.tab, current),
      );
      if (
        !current() ||
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
