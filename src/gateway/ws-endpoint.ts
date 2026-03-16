export const WS_ENDPOINT = {
  AGENT: "/gateway/ws-agent",
  ADMIN: "/gateway/ws-admin",
  INTERNAL: "/gateway/ws-internal",
  LEGACY: "/gateway",
} as const;

export type WsEndpoint = (typeof WS_ENDPOINT)[keyof typeof WS_ENDPOINT];

export interface EndpointSecurityConfig {
  requireOrigin: boolean;
  requireAuth: boolean;
  allowedCapabilities: readonly string[];
}

export const ENDPOINT_SECURITY: Record<WsEndpoint, EndpointSecurityConfig> = {
  [WS_ENDPOINT.AGENT]: {
    requireOrigin: true,
    requireAuth: true,
    allowedCapabilities: ["agent:read", "agent:write", "agent:execute"],
  },
  [WS_ENDPOINT.ADMIN]: {
    requireOrigin: true,
    requireAuth: true,
    allowedCapabilities: [
      "admin:read",
      "admin:write",
      "admin:execute",
      "admin:config",
      "session:manage",
    ],
  },
  [WS_ENDPOINT.INTERNAL]: {
    requireOrigin: false,
    requireAuth: true,
    allowedCapabilities: ["internal:*"],
  },
  [WS_ENDPOINT.LEGACY]: {
    requireOrigin: true,
    requireAuth: true,
    allowedCapabilities: ["*"],
  },
};

export function classifyWsEndpoint(pathname: string): WsEndpoint {
  const normalized = pathname.replace(/\/$/, "") as WsEndpoint;
  if (normalized === WS_ENDPOINT.AGENT) {
    return WS_ENDPOINT.AGENT;
  }
  if (normalized === WS_ENDPOINT.ADMIN) {
    return WS_ENDPOINT.ADMIN;
  }
  if (normalized === WS_ENDPOINT.INTERNAL) {
    return WS_ENDPOINT.INTERNAL;
  }
  return WS_ENDPOINT.LEGACY;
}

export function getEndpointSecurity(endpoint: WsEndpoint): EndpointSecurityConfig {
  return ENDPOINT_SECURITY[endpoint] ?? ENDPOINT_SECURITY[WS_ENDPOINT.LEGACY];
}
