import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { projectAgentSelection, projectGateway } from "../../lib/reactive/application.ts";
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

  const selection = projectAgentSelection(context.agentSelection);
  const scopeId = createMemo(() => selection.read().state.scopeId?.trim() || null);
  const query = createMemo(() => dashboardSessionListQuery(scopeId()));
  const list = createMemo(() => projectSessionList({ sessions: context.sessions, scope: query() }));
  const data = createMemo<DashboardsRouteData>((previous) => {
    const snapshot = list().read();
    const retained = previous ?? initialData;
    return !snapshot.result && !snapshot.error && retained?.result
      ? retained
      : dashboardsRouteData(context, snapshot);
  });
  createEffect(
    () => ({ projection: list(), scope: query() }),
    ({ projection, scope }) => {
      const apply = () => {
        const snapshot = untrack(projection.read);
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
      // Append during the owner's completion notification, before its request drain settles.
      const stop = projection.subscribe(apply);
      apply();
      return stop;
    },
  );

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
