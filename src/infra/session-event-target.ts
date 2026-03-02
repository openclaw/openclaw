export function isAgentScopedSessionKey(sessionKey?: string): boolean {
  return typeof sessionKey === "string" && sessionKey.trim().toLowerCase().startsWith("agent:");
}
