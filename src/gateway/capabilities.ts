export const CAPABILITY = {
  READ: "read",
  WRITE: "write",
  EXECUTE: "execute",
  ADMIN_READ: "admin:read",
  ADMIN_WRITE: "admin:write",
  ADMIN_EXECUTE: "admin:execute",
  ADMIN_CONFIG: "admin:config",
  SESSION_MANAGE: "session:manage",
  AGENT_READ: "agent:read",
  AGENT_WRITE: "agent:write",
  AGENT_EXECUTE: "agent:execute",
  INTERNAL: "internal:*",
} as const;

export type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY];

export interface SessionCapabilities {
  capabilities: Set<string>;
  isAdmin: boolean;
}

export interface AuthenticatedSession {
  clientId: string;
  role?: string;
  scopes?: string[];
  capabilities: SessionCapabilities;
}

export function createSessionCapabilities(scopes?: string[]): SessionCapabilities {
  const caps = new Set<string>(scopes ?? []);
  const isAdmin = caps.has("*") || caps.has("admin:*") || caps.has("admin:write");

  return {
    capabilities: caps,
    isAdmin,
  };
}

export function hasCapability(session: SessionCapabilities, required: string): boolean {
  if (session.capabilities.has("*")) {
    return true;
  }
  if (session.capabilities.has(required)) {
    return true;
  }
  const [namespace] = required.split(":");
  if (session.capabilities.has(`${namespace}:*`)) {
    return true;
  }
  return false;
}

export function validateCapabilityAccess(
  session: SessionCapabilities,
  requiredCapabilities: readonly string[],
): { ok: true } | { ok: false; missing: string } {
  for (const required of requiredCapabilities) {
    if (!hasCapability(session, required)) {
      return { ok: false, missing: required };
    }
  }
  return { ok: true };
}

export function filterCapabilities(
  available: readonly string[],
  allowed: readonly string[],
): string[] {
  return available.filter((cap) => {
    if (allowed.includes("*") || allowed.includes("internal:*")) {
      return true;
    }
    if (allowed.includes(cap)) {
      return true;
    }
    const [namespace] = cap.split(":");
    return allowed.includes(`${namespace}:*`);
  });
}
