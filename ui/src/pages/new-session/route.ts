import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveCreateTarget } from "./catalog-target.ts";
import { newSessionLocationFromSearch, type NewSessionRouteData } from "./location.ts";

async function connectedGatewayClient(
  context: ApplicationContext,
): Promise<GatewayBrowserClient | null> {
  const current = context.gateway.snapshot;
  if (current.connected && current.client) {
    return current.client;
  }
  return await new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let unsubscribe: () => void = () => undefined;
    const finish = (client: GatewayBrowserClient | null) => {
      if (done) {
        return;
      }
      done = true;
      globalThis.clearTimeout(timer);
      unsubscribe();
      resolve(client);
    };
    unsubscribe = context.gateway.subscribe((snapshot) => {
      if (snapshot.connected && snapshot.client) {
        finish(snapshot.client);
      }
    });
    if (done) {
      unsubscribe();
      return;
    }
    const refreshed = context.gateway.snapshot;
    if (refreshed.connected && refreshed.client) {
      finish(refreshed.client);
    }
    if (!done) {
      timer = globalThis.setTimeout(() => finish(null), 5_000);
    }
  });
}

async function loadNewSessionData(
  context: ApplicationContext,
  search: string,
): Promise<NewSessionRouteData> {
  const location = newSessionLocationFromSearch(search);
  const plain = { ...location, model: "", catalogLabel: "" };
  if (!location.catalogId) {
    return plain;
  }
  const client = await connectedGatewayClient(context);
  if (!client) {
    return plain;
  }
  const target = await resolveCreateTarget(client, location.catalogId);
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
