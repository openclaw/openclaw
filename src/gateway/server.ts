export { truncateCloseReason } from "./server/close-reason.js";
export type { GatewayServer, GatewayServerOptions } from "./server.impl.js";
async function loadServerImpl() {
  return await import("./server.impl.js");
}

export async function startGatewayServer(
  ...args: Parameters<typeof import("./server.impl.js").startGatewayServer>
): ReturnType<typeof import("./server.impl.js").startGatewayServer> {
  const mod = await loadServerImpl();
  return await mod.startGatewayServer(...args);
}

export async function __resetModelCatalogCacheForTest(): Promise<void> {
  const mod = await loadServerImpl();
  mod.__resetModelCatalogCacheForTest();
}
