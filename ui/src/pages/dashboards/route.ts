import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionListSnapshot } from "../../lib/sessions/index.ts";
import { resolveSessionNavigationAgentId } from "../../lib/sessions/route-navigation.ts";
import {
  isUiGlobalScopeConfigured,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { dashboardSessionListQuery } from "../../lib/sessions/session-requests.ts";
import type { DashboardsRouteData } from "./view.tsx";

export function dashboardsRouteData(
  context: ApplicationContext,
  snapshot: SessionListSnapshot,
): DashboardsRouteData {
  const sessionConfig = {
    agentsList: context.agents.state.agentsList,
    hello: context.gateway.snapshot.hello,
  };
  return {
    result: snapshot.result,
    error: snapshot.error,
    basePath: context.basePath,
    fallbackAgentId: resolveSessionNavigationAgentId(context),
    globalScope: isUiGlobalScopeConfigured(sessionConfig),
    mainKey: resolveUiConfiguredMainKey(sessionConfig),
  };
}

async function loadDashboardsRoute(context: ApplicationContext): Promise<DashboardsRouteData> {
  const query = dashboardSessionListQuery(context.agentSelection.state.scopeId);
  let snapshot = context.sessions.listSnapshot(query);
  if (!snapshot.result && !snapshot.loading) {
    await context.sessions.refreshList(query);
    snapshot = context.sessions.listSnapshot(query);
  }
  return dashboardsRouteData(context, snapshot);
}

export const page = definePage({
  ...routePageSpec("dashboards"),
  loader: loadDashboardsRoute,
  component: () =>
    import("./dashboards-page.tsx").then((module) => ({
      header: true,
      renderSolid: (props: SolidRouteProps<DashboardsRouteData>) =>
        createComponent(module.DashboardsPage, {
          get routeData() {
            return props.data;
          },
        }),
    })),
});
