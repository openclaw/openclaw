export function agentRoster<Scope extends string>(
  names: Record<string, string>,
  defaultId: string,
  scope: Scope,
) {
  return {
    agents: Object.entries(names).map(([id, name]) => ({ id, name })),
    defaultId,
    mainKey: "main",
    scope,
  };
}
