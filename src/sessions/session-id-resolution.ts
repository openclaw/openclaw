import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";
import { toAgentRequestSessionKey } from "../routing/session-key.js";

type SessionIdMatch = [string, SessionEntry];
type SessionIdMatchSelection =
  | { kind: "none" }
  | { kind: "ambiguous"; sessionKeys: string[] }
  | { kind: "selected"; sessionKey: string };

function newestFirst([, a]: SessionIdMatch, [, b]: SessionIdMatch): number {
  return (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0);
}

// Structural suffix/request-key matches beat fuzzy matches; ties between
// distinct sessions remain ambiguous, in their original store order.
export function resolveSessionIdMatchSelection(
  matches: SessionIdMatch[],
  sessionId: string,
): SessionIdMatchSelection {
  if (matches.length === 0) {
    return { kind: "none" };
  }
  const aliases = new Map<string, SessionIdMatch[]>();
  for (const match of matches) {
    const key = normalizeLowercaseStringOrEmpty(toAgentRequestSessionKey(match[0]) ?? match[0]);
    const group = aliases.get(key) ?? [];
    group.push(match);
    aliases.set(key, group);
  }
  const normalizedId = normalizeLowercaseStringOrEmpty(sessionId);
  const canonical: SessionIdMatch[] = [];
  const structural: SessionIdMatch[] = [];
  for (const [requestKey, group] of aliases) {
    // A fresh alias wins; equal timestamps prefer canonical spelling, then key order.
    const selected = group.toSorted((a, b) => {
      const timeDiff = newestFirst(a, b);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      const left = normalizeLowercaseStringOrEmpty(a[0]);
      const right = normalizeLowercaseStringOrEmpty(b[0]);
      const leftCanonical = a[0] === left;
      const rightCanonical = b[0] === right;
      return leftCanonical !== rightCanonical
        ? leftCanonical
          ? -1
          : 1
        : left < right
          ? -1
          : left > right
            ? 1
            : 0;
    })[0]!;
    canonical.push(selected);
    if (
      normalizeLowercaseStringOrEmpty(selected[0]).endsWith(`:${normalizedId}`) ||
      requestKey === normalizedId ||
      requestKey.endsWith(`:${normalizedId}`)
    ) {
      structural.push(selected);
    }
  }
  const candidates = structural.length > 0 ? structural : canonical;
  const [freshest, second] = candidates.toSorted(newestFirst);
  const selected =
    candidates.length === 1 || (freshest?.[1]?.updatedAt ?? 0) > (second?.[1]?.updatedAt ?? 0);
  return selected
    ? { kind: "selected", sessionKey: freshest![0] }
    : { kind: "ambiguous", sessionKeys: candidates.map(([key]) => key) };
}

export function resolvePreferredSessionKeyForSessionIdMatches(
  matches: SessionIdMatch[],
  sessionId: string,
): string | undefined {
  const selection = resolveSessionIdMatchSelection(matches, sessionId);
  return selection.kind === "selected" ? selection.sessionKey : undefined;
}
