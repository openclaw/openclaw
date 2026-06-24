export function resolveSessionCreateParams(
  sessionKey: string,
  agentId: string,
  options: { emitCommandHooksWithoutParent?: boolean } = {},
) {
  const normalizedSessionKey = sessionKey.trim();
  const parentSessionKey =
    normalizedSessionKey && normalizedSessionKey.toLowerCase() !== "unknown"
      ? normalizedSessionKey
      : undefined;
  return {
    agentId,
    ...(parentSessionKey ? { parentSessionKey, emitCommandHooks: true } : {}),
    ...(parentSessionKey === undefined && options.emitCommandHooksWithoutParent !== undefined
      ? { emitCommandHooks: options.emitCommandHooksWithoutParent }
      : {}),
  };
}
