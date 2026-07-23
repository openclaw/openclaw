import { state } from "lit/decorators.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { compareSessionRowsByUpdatedAt } from "../lib/sessions/index.ts";
import { AppSidebarBase } from "./app-sidebar-base.ts";
import { adoptedCatalogSessionKeys } from "./app-sidebar-session-catalogs.ts";
import { SessionPullRequestIndicatorsController } from "./app-sidebar-session-pr-indicators.ts";
import type {
  SidebarRecentSession,
  SidebarSessionSortMode,
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { SessionDataController } from "./session-data-controller.ts";

/** Shared ordering and PR-state projection used by sidebar navigation. */
export abstract class AppSidebarSessionProjectionElement extends AppSidebarBase {
  @state() protected sessionSortMode: SidebarSessionSortMode = "created";

  readonly sessionData = new SessionDataController(this);
  private readonly sessionPullRequestIndicators = new SessionPullRequestIndicatorsController(this, {
    getConnected: () => this.connected,
    getRows: () => this.visibleSessionPullRequestRows(),
    getSelectedAgentId: () => this.selectedAgentIdForSessions(),
    getSnapshot: () => this.context?.gateway.snapshot,
  });

  get sessionDataContext() {
    return this.context;
  }

  protected readonly compareSidebarSessionRows = (
    a: SessionsListResult["sessions"][number],
    b: SessionsListResult["sessions"][number],
  ) => {
    if (this.sessionSortMode === "updated") {
      return compareSessionRowsByUpdatedAt(a, b);
    }
    return (
      (this.sessionData.sessionCreatedOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
      (this.sessionData.sessionCreatedOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER)
    );
  };

  promoteCreatedSession(sessionKey: string) {
    const currentOrder = this.sessionData.sessionCreatedOrder.get(sessionKey);
    if (currentOrder === 0) {
      return;
    }
    for (const [key, order] of this.sessionData.sessionCreatedOrder) {
      if (key !== sessionKey && (currentOrder === undefined || order < currentOrder)) {
        this.sessionData.sessionCreatedOrder.set(key, order + 1);
      }
    }
    this.sessionData.sessionCreatedOrder.set(sessionKey, 0);
    this.requestUpdate();
  }

  sessionPullRequestIndicatorState(sessionKey: string, worktreeId: string) {
    return this.sessionPullRequestIndicators.state(sessionKey, worktreeId);
  }

  private visibleSessionPullRequestRows(): SidebarRecentSession[] {
    const rows = this.visibleSessionRowsInOrder();
    const adopted = adoptedCatalogSessionKeys(this.sessionData.sessionCatalogs);
    if (adopted.size === 0) {
      return rows;
    }
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const liveRows = [
      ...(this.sessionData.sessionsResult?.sessions ?? []),
      ...Object.values(this.sessionData.sessionRowsByAgent).flat(),
    ];
    for (const row of liveRows) {
      if (adopted.has(row.key) && !byKey.has(row.key)) {
        byKey.set(row.key, this.projectSidebarSession(row));
      }
    }
    return [...byKey.values()];
  }

  protected abstract visibleSessionRowsInOrder(): SidebarRecentSession[];
  protected abstract projectSidebarSession(row: GatewaySessionRow): SidebarRecentSession;
  abstract dismissTransientMenus(): boolean;
  abstract expandedAgentId(): string;
  abstract selectedAgentIdForSessions(): string;
  abstract sidebarSessionStatusFilter(): SidebarSessionStatusFilter;
}
