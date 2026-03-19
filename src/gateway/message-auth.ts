export interface MessageAuthorizationContext {
  clientId: string;
  role?: string;
  scopes: Set<string>;
  endpoint: string;
  connectedAt: number;
}

export interface MessageAuthorizationResult {
  ok: true;
  capability: string;
}
export interface MessageAuthorizationDenied {
  ok: false;
  reason: string;
  missingCapability: string;
}
export type MessageAuthorization = MessageAuthorizationResult | MessageAuthorizationDenied;

export interface MessageAuthConfig {
  messageCapabilities: Map<string, string>;
  requireCapabilityForAll: boolean;
  logDenied: boolean;
}

const DEFAULT_MESSAGE_CAPABILITIES: Record<string, string> = {
  "gateway.method.invoke": "admin:execute",
  "gateway.method.read_config": "admin:read",
  "gateway.method.write_config": "admin:write",
  "gateway.method.list_sessions": "admin:read",
  "gateway.method.kill_session": "session:manage",
  "gateway.event.presence": "agent:read",
  "gateway.event.message": "agent:read",
  "gateway.event.error": "agent:read",
};

export function createMessageAuthContext(params: {
  clientId: string;
  role?: string;
  scopes?: string[];
  endpoint: string;
}): MessageAuthorizationContext {
  return {
    clientId: params.clientId,
    role: params.role,
    scopes: new Set(params.scopes ?? []),
    endpoint: params.endpoint,
    connectedAt: Date.now(),
  };
}

export function hasMessageCapability(ctx: MessageAuthorizationContext, required: string): boolean {
  if (ctx.scopes.has("*")) {
    return true;
  }
  if (ctx.scopes.has(required)) {
    return true;
  }
  const [namespace] = required.split(":");
  if (ctx.scopes.has(`${namespace}:*`)) {
    return true;
  }
  return false;
}

export function authorizeMessage(
  ctx: MessageAuthorizationContext,
  messageType: string,
  config?: Partial<MessageAuthConfig>,
): MessageAuthorization {
  const messageCapability =
    config?.messageCapabilities?.get(messageType) ?? DEFAULT_MESSAGE_CAPABILITIES[messageType];

  if (!messageCapability) {
    if (config?.requireCapabilityForAll) {
      return {
        ok: false,
        reason: `No capability defined for message type: ${messageType}`,
        missingCapability: "unknown",
      };
    }
    return { ok: true, capability: "none" };
  }

  if (hasMessageCapability(ctx, messageCapability)) {
    return { ok: true, capability: messageCapability };
  }

  if (config?.logDenied) {
    console.warn(
      `[MessageAuth] Denied: client=${ctx.clientId} type=${messageType} required=${messageCapability}`,
    );
  }

  return {
    ok: false,
    reason: `Capability denied: ${messageCapability} required for ${messageType}`,
    missingCapability: messageCapability,
  };
}
