import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ApplicationContext } from "../app/context.ts";
import type {
  SessionListOptions,
  SessionListSnapshot,
} from "../lib/sessions/session-capability.ts";
import { dashboardSessionListQuery } from "../lib/sessions/session-requests.ts";

/** Read-only catalog projection. Managed session queries own access, freshness, and pagination. */
export class SidebarNavigationCatalog implements ReactiveController {
  dashboards: SessionListSnapshot | null = null;
  private source?: ApplicationContext["sessions"];
  private client?: ApplicationContext["gateway"]["snapshot"]["client"];
  private agentId?: string | null;
  private pages?: ReturnType<ApplicationContext["sessions"]["observeList"]>;

  constructor(
    private readonly host: ReactiveControllerHost & {
      navigationView: string;
      readonly isConnected: boolean;
    },
    private readonly getContext: () => ApplicationContext | undefined,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.host.requestUpdate();
  }

  hostUpdate(): void {
    if (!this.host.isConnected) {
      return;
    }
    const context = this.getContext();
    const source = context?.gateway.snapshot.phase === "connected" ? context.sessions : undefined;
    const client = context?.gateway.snapshot.client;
    if (source !== this.source || client !== this.client) {
      this.dispose();
      this.source = source;
      this.client = client;
      this.host.requestUpdate();
    }
    const agentId = context?.agentSelection.state.scopeId ?? null;
    if (this.agentId !== agentId) {
      this.pages?.dispose();
      this.pages = undefined;
      this.dashboards = null;
      this.agentId = agentId;
    }
    if (source && this.host.navigationView === "pages" && !this.pages) {
      const query = this.query();
      this.pages = source.observeList(query, (snapshot) => {
        this.dashboards = snapshot;
        this.host.requestUpdate();
      });
      void this.pages.refresh().catch(() => undefined);
    }
  }

  private query(): SessionListOptions {
    return {
      ...dashboardSessionListQuery(this.agentId),
      archivedFilter: "active",
    };
  }

  loadMoreDashboards(): void {
    if (!this.source || !this.dashboards?.result?.hasMore || this.dashboards.loading) {
      return;
    }
    void this.source
      .refreshList({
        ...this.query(),
        append: true,
        offset: this.dashboards.result.nextOffset ?? this.dashboards.result.sessions.length,
      })
      .catch(() => undefined);
  }

  hostDisconnected(): void {
    this.dispose();
  }

  private dispose(): void {
    this.pages?.dispose();
    this.pages = undefined;
    this.source = undefined;
    this.client = undefined;
    this.dashboards = null;
  }
}
