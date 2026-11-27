import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { BrowserRoute, BrowserTabTarget } from "./browser-target.ts";

export function browserRequestReferencedTabs(tabs: readonly BrowserTabTarget[]) {
  return tabs.slice(-64);
}

export function browserRouteParams(route?: BrowserRoute, query?: Record<string, unknown> | null) {
  return route
    ? {
        target: route.target,
        ...(route.target === "node" ? { node: route.node } : {}),
        query: { ...query, profile: route.profile },
      }
    : {};
}

export function browserSessionTabScope(
  sessionKey: string,
  referencedTabs?: readonly BrowserTabTarget[],
) {
  return {
    sessionKey,
    ...(referencedTabs && { referencedTabs: browserRequestReferencedTabs(referencedTabs) }),
  };
}

const prepared = new WeakMap<GatewayBrowserClient, { key: string; result: Promise<unknown> }>();

export function sessionBrowserTabList(
  mode: "prepare" | "take",
  client: GatewayBrowserClient,
  sessionKey: string,
  route: BrowserRoute | undefined,
  referencedTabs: readonly BrowserTabTarget[],
) {
  const previous = prepared.get(client);
  if (mode === "take" && !previous) {
    return undefined;
  }
  const params = {
    method: "GET",
    path: "/tabs",
    ...browserRouteParams(route),
    tabScope: browserSessionTabScope(sessionKey.trim(), referencedTabs),
  };
  const key = JSON.stringify([client.connectionGeneration, params]);
  if (previous?.key === key) {
    if (mode === "take") {
      prepared.delete(client);
    }
    return previous.result;
  }
  if (mode === "prepare") {
    const entry = { key, result: client.request("browser.request", params) };
    prepared.set(client, entry);
    const discard = () => {
      if (prepared.get(client) === entry) {
        prepared.delete(client);
      }
    };
    void entry.result.catch(discard);
    setTimeout(discard, 1500);
  }
  return undefined;
}
