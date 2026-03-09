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

export const CLI_DEFAULT_OPERATOR_SCOPES: OperatorScope[] = [
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
];

const NODE_ROLE_METHODS = new Set([
  "node.invoke.result",
  "node.event",
  "node.pending.drain",
  "node.canvas.capability.refresh",
  "node.pending.pull",
  "node.pending.ack",
  "skills.bins",
]);

const METHOD_SCOPE_GROUPS: Record<OperatorScope, readonly string[]> = {
  [APPROVALS_SCOPE]: [
    "exec.approval.request",
    "exec.approval.waitDecision",
    "exec.approval.resolve",
  ],
  [PAIRING_SCOPE]: [
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
  ],
  [READ_SCOPE]: [
    "health",
    "doctor.memory.status",
    "logs.tail",
    "channels.status",
    "status",
    "usage.status",
    "usage.cost",
    "tts.status",
    "tts.providers",
    "stt.status",
    "models.list",
    "tools.catalog",
    "agents.list",
    "agent.identity.get",
    "skills.status",
    "skills.list",
    "voicewake.get",
    "memory.status",
    "memory.search",
    "memory.activity",
    "sessions.list",
    "sessions.get",
    "sessions.preview",
    "sessions.resolve",
    "sessions.usage",
    "sessions.usage.timeseries",
    "sessions.usage.logs",
    "cron.list",
    "cron.status",
    "cron.runs",
    "gateway.identity.get",
    "system-presence",
    "last-heartbeat",
    "heartbeat.config",
    "node.list",
    "node.describe",
    "chat.history",
    "config.get",
    "config.schema.lookup",
    "talk.config",
    "agents.files.list",
    "agents.files.get",
    "clawhub.catalog",
    "clawhub.installed",
    "hub.catalog",
    "hub.search",
    "hub.inspect",
    "hub.installed",
    "hub.updates",
    "hub.collections",
    "projects.list",
    "projects.get",
    "projects.getContext",
    "projects.getTelegramBindings",
    "projects.getRootPath",
    "agents.marketplace.browse",
    "agents.marketplace.installed",
    "agents.marketplace.health",
    "agents.marketplace.registries",
    "agents.marketplace.get",
    "agents.marketplace.bundles",
    "mcp.servers.list",
    "mcp.servers.tools",
    "mcp.health.status",
    "mcp.registry.list",
    "mcp.browse.list",
    "teamRuns.list",
    "teamRuns.get",
    "teamTasks.list",
    "teamMessages.list",
    "commands.list",
    "commands.get",
    "commands.getBody",
    "personas.list",
    "personas.get",
    "personas.categories",
    "personas.search",
    "personas.expand",
    "state.info",
    "state.tables",
    "state.schema",
    "state.inspect",
    "state.query",
    "state.settings.list",
    "state.settings.get",
    "state.audit",
    "state.export",
  ],
  [WRITE_SCOPE]: [
    "send",
    "poll",
    "agent",
    "agent.wait",
    "wake",
    "talk.mode",
    "tts.enable",
    "tts.disable",
    "tts.convert",
    "tts.setProvider",
    "stt.transcribe",
    "voicewake.set",
    "node.invoke",
    "chat.send",
    "chat.abort",
    "chat.deleteMessages",
    "browser.request",
    "push.test",
    "clawhub.sync",
    "clawhub.inspect",
    "hub.sync",
    "hub.install",
    "hub.installCollection",
    "agents.marketplace.update",
    "agents.marketplace.disable",
    "agents.marketplace.enable",
    "agents.marketplace.generate",
    "mcp.servers.test",
    "mcp.servers.configure",
    "mcp.servers.enable",
    "mcp.servers.disable",
    "agents.marketplace.health.fix",
    "commands.invoke",
    "teamRuns.create",
    "teamRuns.complete",
    "teamRuns.addMember",
    "teamRuns.updateMember",
    "teamTasks.create",
    "teamTasks.update",
    "teamMessages.send",
    "teamMessages.markRead",
    "node.pending.enqueue",
  ],
  [ADMIN_SCOPE]: [
    "channels.logout",
    "skills.install",
    "skills.update",
    "secrets.reload",
    "secrets.resolve",
    "cron.add",
    "cron.update",
    "cron.remove",
    "cron.run",
    "memory.reindex",
    "sessions.patch",
    "sessions.reset",
    "sessions.delete",
    "sessions.compact",
    "sessions.archive",
    "connect",
    "chat.inject",
    "web.login.start",
    "web.login.wait",
    "set-heartbeats",
    "heartbeat.runNow",
    "system-event",
    "agents.files.set",
    "agents.files.delete",
    "agents.files.create",
    "clawhub.download",
    "clawhub.uninstall",
    "hub.remove",
    "agents.marketplace.remove",
    "agents.marketplace.create",
    "agents.marketplace.bundle.install",
    "agents.marketplace.bundle.create",
    "agents.marketplace.bundle.update",
    "agents.marketplace.bundle.delete",
    "agents.marketplace.registry.add",
    "agents.marketplace.registry.remove",
    "agents.marketplace.sync",
    "mcp.servers.add",
    "mcp.servers.remove",
    "mcp.registry.add",
    "mcp.registry.remove",
    "mcp.registry.sync",
    "mcp.health.check",
    "projects.add",
    "projects.update",
    "projects.archive",
    "projects.bindSession",
    "projects.unbindSession",
    "projects.bindTelegramTopic",
    "projects.unbindTelegramTopic",
    "projects.setRootPath",
    "teamRuns.delete",
    "teamRuns.sweep",
    "teamTasks.delete",
    "commands.create",
    "commands.update",
    "commands.delete",
    "personas.apply",
    "state.settings.set",
  ],
};

const ADMIN_METHOD_PREFIXES = ["exec.approvals.", "config.", "wizard.", "update."] as const;

const METHOD_SCOPE_BY_NAME = new Map<string, OperatorScope>(
  Object.entries(METHOD_SCOPE_GROUPS).flatMap(([scope, methods]) =>
    methods.map((method) => [method, scope as OperatorScope]),
  ),
);

function resolveScopedMethod(method: string): OperatorScope | undefined {
  const explicitScope = METHOD_SCOPE_BY_NAME.get(method);
  if (explicitScope) {
    return explicitScope;
  }
  if (ADMIN_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return ADMIN_SCOPE;
  }
  return undefined;
}

export function isApprovalMethod(method: string): boolean {
  return resolveScopedMethod(method) === APPROVALS_SCOPE;
}

export function isPairingMethod(method: string): boolean {
  return resolveScopedMethod(method) === PAIRING_SCOPE;
}

export function isReadMethod(method: string): boolean {
  return resolveScopedMethod(method) === READ_SCOPE;
}

export function isWriteMethod(method: string): boolean {
  return resolveScopedMethod(method) === WRITE_SCOPE;
}

export function isNodeRoleMethod(method: string): boolean {
  return NODE_ROLE_METHODS.has(method);
}

export function isAdminOnlyMethod(method: string): boolean {
  return resolveScopedMethod(method) === ADMIN_SCOPE;
}

export function resolveRequiredOperatorScopeForMethod(method: string): OperatorScope | undefined {
  return resolveScopedMethod(method);
}

export function resolveLeastPrivilegeOperatorScopesForMethod(method: string): OperatorScope[] {
  const requiredScope = resolveRequiredOperatorScopeForMethod(method);
  if (requiredScope) {
    return [requiredScope];
  }
  // Default-deny for unclassified methods.
  return [];
}

export function authorizeOperatorScopesForMethod(
  method: string,
  scopes: readonly string[],
): { allowed: true } | { allowed: false; missingScope: OperatorScope } {
  if (scopes.includes(ADMIN_SCOPE)) {
    return { allowed: true };
  }
  const requiredScope = resolveRequiredOperatorScopeForMethod(method) ?? ADMIN_SCOPE;
  if (requiredScope === READ_SCOPE) {
    if (scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE)) {
      return { allowed: true };
    }
    return { allowed: false, missingScope: READ_SCOPE };
  }
  if (scopes.includes(requiredScope)) {
    return { allowed: true };
  }
  return { allowed: false, missingScope: requiredScope };
}

export function isGatewayMethodClassified(method: string): boolean {
  if (isNodeRoleMethod(method)) {
    return true;
  }
  return resolveRequiredOperatorScopeForMethod(method) !== undefined;
}
