/** Logical Gateway identity stays separate from its development-server transport. */
export type ControlUiDevGateway = {
  gatewayUrl: string;
  proxyPath: string;
};

declare global {
  var OPENCLAW_UI_DEV_GATEWAY: ControlUiDevGateway | undefined;
}

export function configuredUiDevGateway(): ControlUiDevGateway | undefined {
  return globalThis.OPENCLAW_UI_DEV_GATEWAY;
}

export function isConfiguredUiDevGateway(url: string): boolean {
  const configured = configuredUiDevGateway();
  if (!configured) {
    return false;
  }
  try {
    return new URL(url).href.replace(/\/$/u, "") === configured.gatewayUrl;
  } catch {
    return false;
  }
}

export function uiDevGatewayResourceBasePath(): string | undefined {
  const configured = configuredUiDevGateway();
  return configured
    ? `${configured.proxyPath}${new URL(configured.gatewayUrl).pathname.replace(/\/$/u, "")}`
    : undefined;
}

export function gatewayWebSocketTransportUrl(url: string): string {
  const configured = configuredUiDevGateway();
  if (!configured || !isConfiguredUiDevGateway(url)) {
    return url;
  }
  const transport = new URL(`${configured.proxyPath}${new URL(url).pathname}`, location.href);
  transport.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return transport.href;
}

export function hasSameOriginGatewayTransport(url: string): boolean {
  try {
    const transport = new URL(gatewayWebSocketTransportUrl(url), location.href);
    transport.protocol = transport.protocol.replace(/^ws/u, "http");
    return transport.origin === location.origin;
  } catch {
    return false;
  }
}

/** Translate only resources belonging to the configured Gateway, once. */
export function uiDevGatewayResourceUrl(value: string): string {
  const configured = configuredUiDevGateway();
  if (!configured || value.startsWith(`${configured.proxyPath}/`)) {
    return value;
  }
  const gateway = new URL(configured.gatewayUrl.replace(/^ws/u, "http"));
  let resource: URL;
  try {
    resource = new URL(value, gateway);
  } catch {
    // The resource owner still rejects malformed metadata; unrelated config remains usable.
    return value;
  }
  return resource.origin === gateway.origin
    ? `${configured.proxyPath}${resource.pathname}${resource.search}${resource.hash}`
    : value;
}
