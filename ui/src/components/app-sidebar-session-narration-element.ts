import { state } from "lit/decorators.js";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { AppSidebarMenusElement } from "./app-sidebar-menus.ts";
import { SidebarSessionNarrationController } from "./app-sidebar-session-narration.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

/** Gateway subscription and reactive narration state for the session-list renderer. */
export abstract class AppSidebarSessionNarrationElement extends AppSidebarMenusElement {
  @state() protected sidebarNarrationLines: ReadonlyMap<string, string> = new Map();

  private readonly narration = new SidebarSessionNarrationController((lines) => {
    this.sidebarNarrationLines = lines;
  });
  private readonly narrationSubscriptions = new SubscriptionsController(this);

  protected abstract visibleSessionChildren(
    session: SidebarRecentSession,
  ): readonly SidebarRecentSession[];

  private visibleNarrationRowsInOrder(): SidebarRecentSession[] {
    const rows: SidebarRecentSession[] = [];
    const append = (session: SidebarRecentSession) => {
      rows.push(session);
      if (this.isSessionChildrenExpanded(session)) {
        this.visibleSessionChildren(session).forEach(append);
      }
    };
    this.visibleSessionRowsInOrder().forEach(append);
    return rows;
  }

  constructor() {
    super();
    this.narrationSubscriptions.effect(
      () => this.context?.gateway,
      (gateway) => gateway.subscribeEvents((event) => this.narration.handleEvent(event)),
    );
  }

  override disconnectedCallback() {
    this.narration.disconnect();
    super.disconnectedCallback();
  }

  override updated() {
    super.updated();
    const gateway = this.context?.gateway.snapshot;
    this.narration.sync({
      enabled: this.sidebarLiveActivity,
      connected: this.connected && gateway?.connected === true,
      connectionIdentity: gateway?.client ?? null,
      source: this.context?.sessions ?? null,
      rows: this.visibleNarrationRowsInOrder(),
      openSessionKey: this.activeRouteId === "chat" ? this.getRouteSessionKey() : "",
      agentId: this.selectedAgentIdForSessions(),
    });
  }
}
