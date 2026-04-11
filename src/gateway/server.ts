import { ensureGlobalUndiciEnvProxyDispatcher } from "../infra/net/undici-global-dispatcher.js";

export { truncateCloseReason } from "./server/close-reason.js";
export type { GatewayServer, GatewayServerOptions } from "./server.impl.js";
async function loadServerImpl() {
  return await import("./server.impl.js");
}

export async function startGatewayServer(
  ...args: Parameters<typeof import("./server.impl.js").startGatewayServer>
): ReturnType<typeof import("./server.impl.js").startGatewayServer> {
  // Install the env HTTP proxy dispatcher before loading the gateway impl so
  // every fetch path honors HTTP_PROXY/HTTPS_PROXY, not just LLM calls that
  // happen to flow through per-request bootstrap sites.
  ensureGlobalUndiciEnvProxyDispatcher();
  const mod = await loadServerImpl();
  return await mod.startGatewayServer(...args);
}

export async function __resetModelCatalogCacheForTest(): Promise<void> {
  const mod = await loadServerImpl();
  mod.__resetModelCatalogCacheForTest();
}
