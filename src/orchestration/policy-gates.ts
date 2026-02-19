import { appendAuditEvent } from "./audit-trail.js";

export type Role = "owner" | "admin" | "operator" | "viewer";

const HIGH_RISK_ACTIONS = new Set([
  "plugin.install",
  "plugin.uninstall",
  "plugin.enable",
  "plugin.disable",
  "orchestration.run",
]);

export class PolicyBlockedError extends Error {
  readonly code = "POLICY_BLOCKED";
  constructor(
    message: string,
    readonly details: { action: string; requiredRole: Role; actorRole?: Role },
  ) {
    super(message);
    this.name = "PolicyBlockedError";
  }
}

const ROLE_LEVEL: Record<Role, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
  owner: 3,
};

export function assertPolicyGate(params: {
  action: string;
  actor?: string;
  actorRole?: Role;
  requiredRole?: Role;
  auditFilePath?: string;
}) {
  const requiredRole =
    params.requiredRole ?? (HIGH_RISK_ACTIONS.has(params.action) ? "admin" : "viewer");
  const actorRole = params.actorRole ?? "viewer";
  if (ROLE_LEVEL[actorRole] >= ROLE_LEVEL[requiredRole]) {
    return;
  }

  const message = `Action \"${params.action}\" is blocked by policy (requires ${requiredRole}, got ${actorRole}).`;
  if (params.auditFilePath) {
    appendAuditEvent(params.auditFilePath, {
      type: "policy.blocked",
      actor: params.actor,
      action: params.action,
      reason: message,
      meta: { requiredRole, actorRole },
    });
  }
  throw new PolicyBlockedError(message, {
    action: params.action,
    requiredRole,
    actorRole,
  });
}
