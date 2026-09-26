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

function routeOptions(
  location: RouteLocation,
  storedStatusFilter: SessionArchivedFilter = "active",
) {
  const search = new URLSearchParams(location.search);
  const expandedSessionKey = search.get("session")?.trim() || null;
  // The retired internal `showArchived` param is deliberately not read; Sessions
  // URLs are not a shipped contract and stale links fall back to the Active view.
  const hasExplicitStatus = search.has("status");
  const requestedStatus = search.get("status");
  const statusFilter: SessionArchivedFilter = hasExplicitStatus
    ? requestedStatus === "archived"
      ? "archived"
      : requestedStatus === "all"
        ? "all"
        : "active"
    : expandedSessionKey
      ? "active"
      : storedStatusFilter;
  return { expandedSessionKey, statusFilter, hasExplicitStatus };
}

async function loadSessionsRoute(
  context: ApplicationContext,
  location: RouteLocation,
): Promise<SessionsRouteData> {
  const preferenceState = await import("./route-preferences.runtime.ts");
  const preferences = preferenceState.loadSessionsPagePreferences();
  await context.runtimeConfig.ensureLoaded().catch(() => undefined);
  // The mounted page owns list issuance, including scope/status navigation
  // during a search. Prefetching here bypasses its single in-flight request.
  const { expandedSessionKey, statusFilter } = routeOptions(location, preferences.statusFilter);
  return { expandedSessionKey, statusFilter };
}

export const page = definePage({
  ...routePageSpec("sessions"),
  loaderDeps: (context: ApplicationContext, location: RouteLocation) => {
    const options = routeOptions(location);
    const statusSource = options.hasExplicitStatus ? "explicit" : "stored";
    return `${options.expandedSessionKey ?? ""}\u0000${options.statusFilter}\u0000${statusSource}\u0000${context.agentSelection.state.scopeId ?? "all"}`;
  },
  loader: (context: ApplicationContext, { location }) => loadSessionsRoute(context, location),
  component: () =>
    import("./sessions-page.ts").then(() => ({
      header: true,
      render: (data: SessionsRouteData | undefined) =>
        html`<openclaw-sessions-page .routeData=${data}></openclaw-sessions-page>`,
    })),
});
