import { createMemo, createSignal, createStore, onSettled, untrack } from "solid-js";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectSessionList } from "../../lib/reactive/domain-capabilities.ts";
import { dashboardSessionListQuery } from "../../lib/sessions/session-requests.ts";
import { dashboardsRouteData } from "./route.ts";
import { DashboardsView, type DashboardGalleryFilters, type DashboardsRouteData } from "./view.tsx";

export function DashboardsPage(props: { routeData?: DashboardsRouteData }) {
  const context = useApplication();
  const [filters, setFilters] = createStore<DashboardGalleryFilters>({
    query: "",
    ownerId: "",
    sort: "updated",
  });
  // Loader data is an initial seed; session publications own subsequent updates.
  const initialData = untrack(() => props.routeData);
  const gateway = projectGateway(context.gateway);

  // Galleries span every agent; selecting an agent must not replace the listing source.
  const scope = dashboardSessionListQuery();
  const list = projectSessionList({ sessions: context.sessions, scope });
  const data = createMemo<DashboardsRouteData>((previous) => {
    const snapshot = list.read();
    const retained = previous ?? initialData;
    return !snapshot.result && !snapshot.error && retained?.result
      ? retained
      : dashboardsRouteData(context, snapshot);
  });
  let publication = Promise.withResolvers<void>();
  const [nextPublication, setNextPublication] = createSignal(publication.promise);
  const ready = createMemo(() => {
    const current = data();
    if (current.error) {
      return Promise.reject(new Error(current.error));
    }
    return current.result ? Promise.resolve() : nextPublication();
  });
  onSettled(() => {
    const apply = () => {
      // Wake unresolved reads from the owner's next publication, without another request.
      const previous = publication;
      publication = Promise.withResolvers<void>();
      void setNextPublication(publication.promise);
      previous.resolve();
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
    // Append during the owner's completion notification, before its request drain settles.
    const stopList = list.subscribe(apply);
    apply();
    return () => {
      stopList();
      publication.resolve();
    };
  });

  return (
    <openclaw-dashboards-page>
      <DashboardsView
        data={data()}
        readReady={ready}
        filters={filters}
        handlers={{
          onFilterChange: (filter) =>
            setFilters((draft) => {
              Object.assign(draft, filter);
            }),
          onNavigate: context.navigate,
        }}
        gatewaySnapshot={gateway.read().snapshot}
      />
    </openclaw-dashboards-page>
  );
}
