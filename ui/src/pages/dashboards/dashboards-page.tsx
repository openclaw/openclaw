import { createMemo, createSignal, onSettled, untrack } from "solid-js";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectSessionList } from "../../lib/reactive/domain-capabilities.ts";
import { dashboardSessionListQuery } from "../../lib/sessions/session-requests.ts";
import { dashboardsRouteData } from "./route.ts";
import { DashboardsView, type DashboardGalleryFilters, type DashboardsRouteData } from "./view.tsx";

type DashboardsPageProps = { routeData?: DashboardsRouteData };

export function DashboardsPage(props: DashboardsPageProps) {
  const context = useApplication();
  const [filters, setFilters] = createSignal<DashboardGalleryFilters>({
    query: "",
    ownerId: "",
    sort: "updated",
  });
  // Loader data is an initial seed; session publications own subsequent updates.
  const initialData = untrack(() => props.routeData);
  const gateway = projectGateway(context.gateway);

  let scope = dashboardSessionListQuery(context.agentSelection.state.scopeId);
  const list = projectSessionList({ sessions: context.sessions, scope });
  const data = createMemo<DashboardsRouteData>((previous) => {
    const snapshot = list.read();
    const retained = previous ?? initialData;
    return !snapshot.result && !snapshot.error && retained?.result
      ? retained
      : dashboardsRouteData(context, snapshot);
  });
  onSettled(() => {
    const apply = () => {
      const snapshot = context.sessions.listSnapshot(scope);
      if (snapshot.pagination?.hasMore && !snapshot.loading && !snapshot.error) {
        void context.sessions.refreshList({
          ...scope,
          append: true,
          offset: snapshot.pagination.nextOffset ?? snapshot.pagination.count,
        });
      } else if (
        !snapshot.result &&
        !snapshot.loading &&
        !snapshot.error &&
        context.gateway.snapshot.phase === "connected"
      ) {
        void context.sessions.refreshList(scope);
      }
    };
    const synchronizeScope = () => {
      const next = dashboardSessionListQuery(context.agentSelection.state.scopeId);
      if (next.agentId !== scope.agentId) {
        scope = next;
        list.replaceSource({ sessions: context.sessions, scope });
      }
    };
    const stopScope = context.agentSelection.subscribe(synchronizeScope);
    synchronizeScope();
    // Append during the owner's completion notification, before its request drain settles.
    const stopList = list.subscribe(apply);
    apply();
    return () => {
      stopScope();
      stopList();
    };
  });

  return (
    <openclaw-dashboards-page>
      <DashboardsView
        data={data()}
        filters={filters()}
        handlers={{
          onFilterChange: (filter) => setFilters((current) => ({ ...current, ...filter })),
          onNavigate: context.navigate,
        }}
        gatewaySnapshot={gateway.read().snapshot}
      />
    </openclaw-dashboards-page>
  );
}
