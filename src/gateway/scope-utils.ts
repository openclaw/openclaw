export function connectionHasAgentAccess(scopes: string[], agentId: string): boolean {
  const agentScopes = scopes.filter((scope) => scope.startsWith("agents:"));
  // Back-compat: if the connection has no agent scopes declared, treat it as full access.
  if (agentScopes.length === 0) {
    return true;
  }
  if (agentScopes.includes("agents:*")) {
    return true;
  }
  return agentScopes.includes(`agents:${agentId}`);
}

export function connectionIsOwner(role: string | undefined): boolean {
  // Back-compat: legacy connections didn't always declare a role.
  if (!role) {
    return true;
  }
  return role === "owner" || role === "operator";
}

export function filterAgentsForConnection<T extends { id: string }>(
  agents: T[],
  scopes: string[],
): T[] {
  const agentScopes = scopes.filter((scope) => scope.startsWith("agents:"));
  if (agentScopes.length === 0) {
    return agents;
  }
  if (agentScopes.includes("agents:*")) {
    return agents;
  }
  const allowedIds = new Set(agentScopes.map((scope) => scope.slice("agents:".length)));
  return agents.filter((agent) => allowedIds.has(agent.id));
}
