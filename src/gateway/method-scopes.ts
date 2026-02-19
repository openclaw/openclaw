export const ADMIN_SCOPE = "operator.admin" as const;
export const READ_SCOPE = "operator.read" as const;
export const WRITE_SCOPE = "operator.write" as const;
export const APPROVALS_SCOPE = "operator.approvals" as const;
export const PAIRING_SCOPE = "operator.pairing" as const;

export type OperatorScope =
  | typeof ADMIN_SCOPE
  | typeof READ_SCOPE
  | typeof WRITE_SCOPE
  | typeof APPROVALS_SCOPE
  | typeof PAIRING_SCOPE;

const APPROVAL_METHODS = new Set([
  "exec.approval.request",
  "exec.approval.waitDecision",
  "exec.approval.resolve",
]);

const NODE_ROLE_METHODS = new Set(["node.invoke.result", "node.event", "skills.bins"]);

const PAIRING_METHODS = new Set([
  "node.pair.request",
  "node.pair.list",
  "node.pair.approve",
  "node.pair.reject",
  "node.pair.verify",
  "device.pair.list",
  "device.pair.approve",
  "device.pair.reject",
  "device.pair.remove",
  "device.token.rotate",
  "device.token.revoke",
  "node.rename",
]);

const ADMIN_METHOD_PREFIXES = ["exec.approvals."];

const READ_METHODS = new Set([
  "health",
  "logs.tail",
  "channels.status",
  "status",
  "usage.status",
  "usage.cost",
  "tts.status",
  "tts.providers",
  "models.list",
  "agents.list",
  "agent.identity.get",
  "skills.status",
  "voicewake.get",
  "sessions.list",
  "sessions.preview",
  "cron.list",
  "cron.status",
  "cron.runs",
  "system-presence",
  "last-heartbeat",
  "node.list",
  "node.describe",
  "chat.history",
  "config.get",
  "talk.config",
]);

const WRITE_METHODS = new Set([
  "send",
  "agent",
  "agent.wait",
  "wake",
  "talk.mode",
  "tts.enable",
  "tts.disable",
  "tts.convert",
  "tts.setProvider",
  "voicewake.set",
  "node.invoke",
  "chat.send",
  "chat.abort",
  "browser.request",
  "push.test",
]);

const ADMIN_METHODS = new Set([
  "channels.logout",
  "agents.create",
  "agents.update",
  "agents.delete",
  "skills.install",
  "skills.update",
  "cron.add",
  "cron.update",
  "cron.remove",
  "cron.run",
  "sessions.patch",
  "sessions.reset",
  "sessions.delete",
  "sessions.compact",
]);

export function isApprovalMethod(method: string): boolean {
  return APPROVAL_METHODS.has(method);
}

export function isPairingMethod(method: string): boolean {
  return PAIRING_METHODS.has(method);
}

export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method);
}

export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method);
}

export function isNodeRoleMethod(method: string): boolean {
  return NODE_ROLE_METHODS.has(method);
}

export function isAdminOnlyMethod(method: string): boolean {
  if (ADMIN_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return true;
  }
  if (
    method.startsWith("config.") ||
    method.startsWith("wizard.") ||
    method.startsWith("update.")
  ) {
    return true;
  }
  return ADMIN_METHODS.has(method);
}

export function resolveLeastPrivilegeOperatorScopesForMethod(method: string): OperatorScope[] {
  if (isApprovalMethod(method)) {
    return [APPROVALS_SCOPE];
  }
  if (isPairingMethod(method)) {
    return [PAIRING_SCOPE];
  }
  if (isReadMethod(method)) {
    return [READ_SCOPE];
  }
  if (isWriteMethod(method)) {
    return [WRITE_SCOPE];
  }
  if (isAdminOnlyMethod(method)) {
    return [ADMIN_SCOPE];
  }
  // Default-deny for unclassified methods.
  return [];
}
