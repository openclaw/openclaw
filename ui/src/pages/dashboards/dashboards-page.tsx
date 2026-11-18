import { createMemo, createStore, onSettled, untrack } from "solid-js";
import { serializeSidebarEntry } from "../../app-navigation.ts";
import { DASHBOARDS_DISPLAY_DEFAULTS } from "../../app/settings-contract.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectSessionList } from "../../lib/reactive/domain-capabilities.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { dashboardSessionListQuery } from "../../lib/sessions/session-requests.ts";
import type { DashboardGalleryFilters, DashboardsRouteData } from "./gallery-filters.ts";
import { dashboardsRouteData } from "./route.ts";
import { DashboardsView } from "./view.tsx";

export function DashboardsPage(props: { routeData?: DashboardsRouteData }) {
  const context = useApplication();
  // Display (view, ordering, grouping) is remembered per browser, like other view preferences.
  const [filters, setFilters] = createStore<DashboardGalleryFilters>({
    query: "",
    ownerIds: [],
    ...(loadSettings().dashboardsDisplay ?? DASHBOARDS_DISPLAY_DEFAULTS),
  });
  // Loader data is an initial seed; session publications own subsequent updates.
  const initialData = untrack(() => props.routeData);
  const gateway = projectGateway(context.gateway);
  // Personal rail pins: the same navigation preference the sidebar's session pins write.
  const navigation = projectOwner(context.navigation, (owner) => owner.snapshot);
  const railPin = (key: string) => serializeSidebarEntry({ type: "session", key, rail: true });

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
    // Selection receipts replace the list scope before it can request another agent's page.
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
        filters={filters}
        handlers={{
          onFilterChange: (filter) => {
            const display = {
              view: filter.view ?? filters.view,
              sort: filter.sort ?? filters.sort,
              group: filter.group ?? filters.group,
            };
            setFilters((draft) => {
              Object.assign(draft, filter);
            });
            if (filter.view || filter.sort || filter.group) {
              patchSettings({ dashboardsDisplay: display });
            }
          },
          onNavigate: context.navigate,
          isPinned: (key) => navigation.read().sidebarEntries.includes(railPin(key)),
          onTogglePin: (key) => {
            const entry = railPin(key);
            const entries = context.navigation.snapshot.sidebarEntries;
            context.navigation.update({
              sidebarEntries: entries.includes(entry)
                ? entries.filter((value) => value !== entry)
                : [...entries, entry],
            });
          },
        }}
        gatewaySnapshot={gateway.read().snapshot}
      />
    </openclaw-dashboards-page>
  );
}
