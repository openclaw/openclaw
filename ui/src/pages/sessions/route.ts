import type { RouteLocation } from "@openclaw/uirouter";
import { defineSolidPage } from "../../app-route-types.tsx";
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

export const page = defineSolidPage<"sessions", ApplicationContext, SessionsRouteData>(
  "sessions",
  () => import("./sessions-page.tsx").then((module) => module.SessionsPage),
  {
    loaderDeps: (context: ApplicationContext, location: RouteLocation) => {
      const options = routeOptions(location);
      return `${options.expandedSessionKey ?? ""}\u0000${options.statusFilter}\u0000${context.agentSelection.state.scopeId ?? "all"}`;
    },
    loader: (context: ApplicationContext, { location }): SessionsRouteData => {
      // Config decorates the page; it is not a prerequisite for the session roster.
      void context.runtimeConfig.ensureLoaded().catch(() => undefined);
      // The mounted page owns list issuance, including scope/status navigation
      // during a search. Prefetching here bypasses its single in-flight request.
      return routeOptions(location);
    },
  },
);
