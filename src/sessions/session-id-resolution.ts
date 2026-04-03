import type { SessionEntry } from "../config/sessions.js";
import { toAgentRequestSessionKey } from "../routing/session-key.js";

type SessionIdMatch = [string, SessionEntry];

function compareUpdatedAtDescending(a: SessionIdMatch, b: SessionIdMatch): number {
  return (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0);
}

function compareStoreKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function collapseAliasMatches(matches: SessionIdMatch[]): SessionIdMatch[] {
  const grouped = new Map<string, SessionIdMatch[]>();
  for (const match of matches) {
    const requestKey = toAgentRequestSessionKey(match[0]) ?? match[0];
    const normalizedRequestKey = requestKey.trim().toLowerCase();
    const bucket = grouped.get(normalizedRequestKey);
    if (bucket) {
      bucket.push(match);
    } else {
      grouped.set(normalizedRequestKey, [match]);
    }
  }

  return Array.from(grouped.values(), (group) => {
    if (group.length === 1) {
      return group[0];
    }
    return [...group].toSorted((a, b) => {
      const timeDiff = compareUpdatedAtDescending(a, b);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      const aNormalizedKey = a[0].trim().toLowerCase();
      const bNormalizedKey = b[0].trim().toLowerCase();
      const aIsCanonical = a[0] === aNormalizedKey;
      const bIsCanonical = b[0] === bNormalizedKey;
      if (aIsCanonical !== bIsCanonical) {
        return aIsCanonical ? -1 : 1;
      }
      return compareStoreKeys(aNormalizedKey, bNormalizedKey);
    })[0];
  });
}

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
  const canonicalMatches = collapseAliasMatches(matches);
  if (canonicalMatches.length === 1) {
    return canonicalMatches[0][0];
  }
  const structuralMatches = canonicalMatches.filter(([storeKey]) => {
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

  const structuralSorted = [...structuralMatches].toSorted(compareUpdatedAtDescending);
  const [freshestStructural, secondFreshestStructural] = structuralSorted;
  if (structuralMatches.length > 1) {
    if (
      (freshestStructural?.[1]?.updatedAt ?? 0) > (secondFreshestStructural?.[1]?.updatedAt ?? 0)
    ) {
      return freshestStructural[0];
    }
    return undefined;
  }

  const sortedMatches = [...canonicalMatches].toSorted(compareUpdatedAtDescending);
  const [freshest, secondFreshest] = sortedMatches;
  if ((freshest?.[1]?.updatedAt ?? 0) > (secondFreshest?.[1]?.updatedAt ?? 0)) {
    return freshest[0];
  }

  return undefined;
}
