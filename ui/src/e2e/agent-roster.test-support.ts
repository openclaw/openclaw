export function agentRoster(names: Record<string, string>, defaultId: string, scope: string) {
  return {
    agents: Object.entries(names).map(([id, name]) => ({ id, name })),
    defaultId,
    mainKey: "main",
    scope,
  };
}
