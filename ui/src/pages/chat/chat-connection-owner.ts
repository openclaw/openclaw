import type { GatewayBrowserClient } from "../../api/gateway.ts";

export function captureChatConnectionOwner(
  host: { client?: GatewayBrowserClient | null; connected: boolean; connectionEpoch?: number },
  requireConnected = true,
): () => boolean {
  const { client, connectionEpoch } = host;
  return () =>
    (!requireConnected || host.connected) &&
    host.client === client &&
    host.connectionEpoch === connectionEpoch;
}
