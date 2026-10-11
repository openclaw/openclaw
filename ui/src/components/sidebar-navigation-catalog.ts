import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ApplicationContext } from "../app/context.ts";
import type { SessionListSnapshot } from "../lib/sessions/session-capability.ts";
import { dashboardSessionListQuery } from "../lib/sessions/session-requests.ts";
import { navigationScopesEquivalent } from "./app-sidebar-session-navigation-logic.ts";

const OWNER_SUMMARY_QUERY = {
  source: "sidebar",
  limit: 1,
  rowMode: "compact",
  includeOwnerSessionCounts: true,
  includeDerivedTitles: false,
  includeLastMessage: false,
  includeGlobal: false,
  includeUnknown: false,
  excludeDock: true,
  archivedFilter: "active",
} as const;

/** Read-only catalog projection. Managed session queries own access, freshness, and pagination. */
export class SidebarNavigationCatalog implements ReactiveController {
  dashboards: SessionListSnapshot | null = null;
  scopesEquivalent = false;
  scopesReady = false;
  private source?: ApplicationContext["sessions"];
  private client?: ApplicationContext["gateway"]["snapshot"]["client"];
  private viewerId?: string;
  private agentId?: string | null;
  private owners?: ReturnType<ApplicationContext["sessions"]["observeList"]>;
  private pages?: ReturnType<ApplicationContext["sessions"]["observeList"]>;
  private generation = 0;

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
    const viewerId = context?.gateway.snapshot.selfUser?.id;
    if (source !== this.source || client !== this.client || viewerId !== this.viewerId) {
      this.dispose();
      this.source = source;
      this.client = client;
      this.viewerId = viewerId;
      if (source && context && viewerId) {
        const generation = this.generation;
        const scope = source.captureConnectionScope();
        let ready = false;
        let latest: SessionListSnapshot | undefined;
        const publish = () => {
          if (generation !== this.generation || !scope || !source.isConnectionScopeCurrent(scope)) {
            return;
          }
          // Totals include unowned/agent-owned rows missing from the profile facet.
          const equivalent = ready && navigationScopesEquivalent(latest, viewerId);
          if (equivalent !== this.scopesEquivalent || ready !== this.scopesReady) {
            this.scopesReady = ready;
            this.scopesEquivalent = equivalent;
            this.host.requestUpdate();
          }
        };
        this.owners = source.observeList(OWNER_SUMMARY_QUERY, (snapshot) => {
          latest = snapshot;
          publish();
        });
        const owners = this.owners;
        const refresh = async () => {
          try {
            await owners.refresh();
          } catch {
            /* Observation publishes failure. */
          }
          ready = true;
          publish();
        };
        if (context.connectionBootstrap) {
          void context.connectionBootstrap.run(owners, refresh, { background: true });
        } else {
          void refresh();
        }
      }
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
      const generation = this.generation;
      const query = dashboardSessionListQuery(agentId);
      this.pages = source.observeList(query, (snapshot) => {
        if (generation !== this.generation || source !== this.source || agentId !== this.agentId) {
          return;
        }
        this.dashboards = snapshot;
        this.host.requestUpdate();
      });
      void this.pages.refresh().catch(() => undefined);
    }
  }

  loadMoreDashboards(): void {
    if (!this.source || !this.dashboards?.result?.hasMore || this.dashboards.loading) {
      return;
    }
    void this.source
      .refreshList({
        ...dashboardSessionListQuery(this.agentId),
        append: true,
        offset: this.dashboards.result.nextOffset ?? this.dashboards.result.sessions.length,
      })
      .catch(() => undefined);
  }

  hostDisconnected(): void {
    this.dispose();
  }

  private dispose(): void {
    this.generation += 1;
    this.owners?.dispose();
    this.pages?.dispose();
    this.owners = undefined;
    this.pages = undefined;
    this.source = undefined;
    this.client = undefined;
    this.viewerId = undefined;
    this.dashboards = null;
    this.scopesEquivalent = false;
    this.scopesReady = false;
  }
}
