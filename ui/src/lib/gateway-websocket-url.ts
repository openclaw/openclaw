function useWebSocketProtocol(url: URL): URL {
  if (url.protocol === "http:" || url.protocol === "https:") {
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  }
  return url;
}

export function resolveGatewayWebSocketUrl(
  wsUrl: string,
  gatewayUrl = globalThis.location?.href,
): string {
  const base = useWebSocketProtocol(
    new URL(gatewayUrl ?? globalThis.location.href, globalThis.location?.href),
  );
  const resolved = useWebSocketProtocol(new URL(wsUrl, base));
  if (resolved.protocol !== "ws:" && resolved.protocol !== "wss:") {
    throw new Error("Gateway stream URL must use WebSocket transport");
  }
  return resolved.toString();
}
