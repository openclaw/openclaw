import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveCreateTarget } from "./catalog-target.ts";
import { newSessionLocationFromSearch, type NewSessionRouteData } from "./location.ts";

async function loadNewSessionData(
  context: ApplicationContext,
  search: string,
): Promise<NewSessionRouteData> {
  const location = newSessionLocationFromSearch(search);
  const plain = { ...location, model: "", catalogLabel: "" };
  if (!location.catalogId) {
    return plain;
  }
  const gateway = context.gateway.snapshot;
  if (!gateway.connected || !gateway.client) {
    return plain;
  }
  const target = await resolveCreateTarget(gateway.client, location.catalogId);
  return target ? { ...location, ...target } : plain;
}

export const page = definePage({
  id: "new-session",
  path: "/new",
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
  loader: (context: ApplicationContext, { location }) =>
    loadNewSessionData(context, location.search),
  component: () =>
    import("./new-session-page.ts").then(() => ({
      render: (data: unknown) =>
        html`<openclaw-new-session-page .data=${data}></openclaw-new-session-page>`,
    })),
});
