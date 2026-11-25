export function navigationAgents(
  ids: string[],
  scope = "agent",
  model?: string,
  identities = false,
) {
  return {
    defaultId: ids[0],
    mainKey: "main",
    scope,
    agents: ids.map((id) => {
      const name = id.charAt(0).toUpperCase() + id.slice(1);
      return {
        id,
        name,
        ...(identities ? { identity: { name } } : {}),
        ...(model ? { model: { primary: model } } : {}),
      };
    }),
  };
}

export const navigationDevice = (
  id: string,
  label: string,
  status = "available",
  sessionHost = true,
) => ({ id: `node:${id}`, type: "node", label, status, sessionHost });
