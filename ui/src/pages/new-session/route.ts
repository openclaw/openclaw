import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { SessionsCatalogListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import type { ApplicationContext } from "../../app/context.ts";
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
  try {
    const result = await gateway.client.request<SessionsCatalogListResult>(
      "sessions.catalog.list",
      {
        catalogId: location.catalogId,
        limitPerHost: 1,
      },
    );
    const catalog = result.catalogs.find((candidate) => candidate.id === location.catalogId);
    const model = catalog?.capabilities.createSession?.model.trim();
    return catalog && model
      ? { ...location, model, catalogLabel: catalog.label }
      : { ...plain, catalogId: "" };
  } catch {
    return plain;
  }
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
