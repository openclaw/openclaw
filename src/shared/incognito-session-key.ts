export { isIncognitoSessionKey } from "../../packages/session-url-contract/src/session-key.js";

const INCOGNITO_SESSION_LIFETIME_MS = 24 * 60 * 60_000;

/** Legacy rows retain their known age; observing them never starts a new lifetime. */
export function resolveIncognitoSessionExpiresAt(entry: {
  createdAt?: number;
  updatedAt?: number;
}): number | undefined {
  const startedAt = entry.createdAt ?? entry.updatedAt;
  return startedAt === undefined ? undefined : startedAt + INCOGNITO_SESSION_LIFETIME_MS;
}
