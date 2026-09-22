const INCOGNITO_SESSION_RE =
  /^agent:[^:]+:(?:dashboard|subagent|internal-session-effects):incognito-[^:]+$/u;

/** Classifies process-only agent session keys without consulting runtime registry state. */
export function isIncognitoSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = sessionKey?.trim().toLowerCase();
  if (!raw) {
    return false;
  }
  return INCOGNITO_SESSION_RE.test(raw);
}
