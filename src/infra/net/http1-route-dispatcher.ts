import type { lookup } from "node:dns";
import type { Dispatcher } from "undici";
import {
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
} from "./undici-runtime.js";

type Http1Route =
  | { mode: "direct"; connect?: Record<string, unknown> }
  | {
      mode: "env-proxy";
      connect?: Record<string, unknown>;
      proxyTls?: Record<string, unknown>;
    }
  | { mode: "explicit-proxy"; proxyUrl: string; proxyTls?: Record<string, unknown> };

/** Construct the selected transport after its caller has admitted the route and optional pin. */
export function createHttp1RouteDispatcher(
  route: Http1Route | undefined,
  timeoutMs: number | undefined,
  pin?: { lookup: typeof lookup },
): Dispatcher {
  const connector = (options?: Record<string, unknown>) =>
    pin ? { ...options, lookup: pin.lookup } : options ? { ...options } : undefined;
  if (!route || route.mode === "direct") {
    const connect = connector(route?.connect);
    return createHttp1Agent(connect ? { connect } : undefined, timeoutMs);
  }
  if (route.mode === "env-proxy") {
    const connect = connector(route.connect);
    return createHttp1EnvHttpProxyAgent(
      {
        ...(connect ? { connect } : {}),
        ...(route.proxyTls ? { proxyTls: { ...route.proxyTls } } : {}),
      },
      timeoutMs,
    );
  }
  const proxyUrl = route.proxyUrl.trim();
  // Explicit-proxy transport hints belong to the target hop, including its pinned lookup.
  const requestTls = connector(route.proxyTls);
  return createHttp1ProxyAgent({ uri: proxyUrl, ...(requestTls ? { requestTls } : {}) }, timeoutMs);
}
