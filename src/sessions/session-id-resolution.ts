import type { SessionEntry } from "../config/sessions.js";
import { toAgentRequestSessionKey } from "../routing/session-key.js";

export function resolvePreferredSessionKeyForSessionIdMatches(
  matches: Array<[string, SessionEntry]>,
  sessionId: string,
): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length === 1) {
    return matches[0][0];
  }

  const loweredSessionId = sessionId.trim().toLowerCase();
  const structuralMatches = matches.filter(([storeKey]) => {
    const requestKey = toAgentRequestSessionKey(storeKey)?.toLowerCase();
    return (
      storeKey.toLowerCase().endsWith(`:${loweredSessionId}`) ||
      requestKey === loweredSessionId ||
      requestKey?.endsWith(`:${loweredSessionId}`) === true
    );
  });
  if (structuralMatches.length === 1) {
    return structuralMatches[0][0];
  }

  const sortedMatches = [...matches].toSorted(
    (a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0),
  );
  const [freshest, secondFreshest] = sortedMatches;
  if ((freshest?.[1]?.updatedAt ?? 0) > (secondFreshest?.[1]?.updatedAt ?? 0)) {
    return freshest?.[0];
  }

  return undefined;
}
