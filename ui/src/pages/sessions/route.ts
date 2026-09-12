import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionArchivedFilter } from "../../lib/sessions/index.ts";

export type SessionsRouteData = {
  expandedSessionKey: string | null;
  statusFilter: SessionArchivedFilter;
};

function routeOptions(location: RouteLocation) {
  const search = new URLSearchParams(location.search);
  const expandedSessionKey = search.get("session")?.trim() || null;
  // The retired internal `showArchived` param is deliberately not read; Sessions
  // URLs are not a shipped contract and stale links fall back to the Active view.
  const requestedStatus = search.get("status");
  const statusFilter: SessionArchivedFilter =
    requestedStatus === "archived" ? "archived" : requestedStatus === "all" ? "all" : "active";
  return { expandedSessionKey, statusFilter };
}

async function loadSessionsRoute(
  context: ApplicationContext,
  location: RouteLocation,
): Promise<SessionsRouteData> {
  await context.runtimeConfig.ensureLoaded().catch(() => undefined);
  // The mounted page owns list issuance, including scope/status navigation
  // during a search. Prefetching here bypasses its single in-flight request.
  return routeOptions(location);
}

export const page = definePage({
  ...routePageSpec("sessions"),
  loaderDeps: (context: ApplicationContext, location: RouteLocation) => {
    const options = routeOptions(location);
    return `${options.expandedSessionKey ?? ""}\u0000${options.statusFilter}\u0000${context.agentSelection.state.scopeId ?? "all"}`;
  },
  loader: (context: ApplicationContext, { location }) => loadSessionsRoute(context, location),
  component: () =>
    import("./sessions-page.ts").then(() => ({
      header: true,
      render: (data: SessionsRouteData | undefined) =>
        html`<openclaw-sessions-page .routeData=${data}></openclaw-sessions-page>`,
    })),
});
