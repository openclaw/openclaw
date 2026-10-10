import { createEffect, createMemo, createSignal, onSettled } from "solid-js";
import {
  DASHBOARD_DOCUMENT_ELEMENT,
  ensureCustomElementDefined,
} from "../../app/lazy-custom-element.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { projectAgentSelection, projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectSessionList } from "../../lib/reactive/domain-capabilities.ts";
import { dashboardSessionListQuery } from "../../lib/sessions/session-requests.ts";
import { dashboardsRouteData } from "./route.ts";
import { DashboardsView, type DashboardGalleryFilters, type DashboardsRouteData } from "./view.tsx";

export type DashboardsPageProps = { routeData?: DashboardsRouteData };

export function DashboardsPage(props: DashboardsPageProps) {
  const context = useApplication();
  const [filters, setFilters] = createSignal<DashboardGalleryFilters>({
    query: "",
    ownerId: "",
    sort: "updated",
  });
  const [previewError, setPreviewError] = createSignal<string | null>(null);
  const [data, setData] = createSignal(() => props.routeData);
  const gateway = context ? projectGateway(context.gateway) : undefined;

  if (context) {
    const selection = projectAgentSelection(context.agentSelection);
    const scopeId = createMemo(() => selection.read().state.scopeId?.trim() || null);
    const query = createMemo(() => dashboardSessionListQuery(scopeId()));
    const list = createMemo(() =>
      projectSessionList({ sessions: context.sessions, scope: query() }),
    );
    createEffect(
      () => ({ snapshot: list().read(), query: query() }),
      ({ snapshot, query: scope }) => {
        if (snapshot.result || snapshot.error || !data()?.result) {
          setData(dashboardsRouteData(context, snapshot));
        }
        if (snapshot.result?.hasMore && !snapshot.loading && !snapshot.error) {
          void context.sessions.refreshList({
            ...scope,
            append: true,
            offset: snapshot.result.nextOffset ?? snapshot.result.sessions.length,
          });
        } else if (
          !snapshot.result &&
          !snapshot.loading &&
          !snapshot.error &&
          context.gateway.snapshot.phase === "connected"
        ) {
          void context.sessions.refreshList(scope);
        }
      },
    );
  }

  onSettled(() => {
    let active = true;
    void ensureCustomElementDefined(
      DASHBOARD_DOCUMENT_ELEMENT.tagName,
      DASHBOARD_DOCUMENT_ELEMENT.loadModule,
    ).catch((error: unknown) => {
      if (active) setPreviewError(formatUiError(error));
    });
    return () => {
      active = false;
    };
  });

  return (
    <DashboardsView
      data={data()}
      filters={filters()}
      handlers={{
        onFilterChange: (filter) => setFilters((current) => ({ ...current, ...filter })),
        onNavigate: context?.navigate,
      }}
      gatewaySnapshot={gateway?.read().snapshot}
      previewError={previewError()}
    />
  );
}
