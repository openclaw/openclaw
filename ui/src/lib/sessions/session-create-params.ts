export function resolveSessionCreateParams(sessionKey = "", agentId?: string) {
  const normalizedSessionKey = sessionKey.trim();
  const normalizedAgentId = agentId?.trim();
  const parentSessionKey =
    normalizedSessionKey && normalizedSessionKey.toLowerCase() !== "unknown"
      ? normalizedSessionKey
      : undefined;
  return {
    ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
    ...(parentSessionKey
      ? { parentSessionKey, emitCommandHooks: true, succeedsParent: false }
      : {}),
  };
}
