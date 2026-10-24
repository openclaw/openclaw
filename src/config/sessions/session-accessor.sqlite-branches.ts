import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { SessionBranchSummary } from "./session-accessor.types.js";
import type { SessionBranchSummarySnapshot } from "./session-history-read.types.js";

export type { SessionBranchSummaryReadResult } from "./session-history-read.types.js";

const SESSION_BRANCH_CACHE_MAX_ENTRIES = 64;

type SessionBranchCacheEntry = SessionBranchSummarySnapshot & {
  writeToken: string;
};

export type SessionBranchSummaryReadRequest = {
  database: { agentId: string; path: string };
  sessionKey: string;
  previous?: SessionBranchSummarySnapshot;
};
// The host retains compact summaries across read-worker retirement.
const sessionBranchCache = new Map<string, SessionBranchCacheEntry>();

function sessionBranchCacheKey(databasePath: string, sessionKey: string): string {
  return `${databasePath}\0${sessionKey}`;
}

export function cloneSessionBranchSummaries(branches: readonly SessionBranchSummary[]) {
  return branches.map((branch) => ({ ...branch }));
}

export function readCachedSessionBranchSummaries(
  databasePath: string,
  sessionKey: string,
): SessionBranchCacheEntry | undefined {
  const cacheKey = sessionBranchCacheKey(databasePath, sessionKey);
  const cached = sessionBranchCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  sessionBranchCache.delete(cacheKey);
  sessionBranchCache.set(cacheKey, cached);
  return cached;
}

export function cacheSessionBranchSummaries(
  databasePath: string,
  sessionKey: string,
  writeToken: string | undefined,
  snapshot: SessionBranchSummarySnapshot,
): void {
  if (writeToken === undefined) {
    return;
  }
  const cacheKey = sessionBranchCacheKey(databasePath, sessionKey);
  sessionBranchCache.delete(cacheKey);
  sessionBranchCache.set(cacheKey, {
    ...snapshot,
    writeToken,
  });
  pruneMapToMaxSize(sessionBranchCache, SESSION_BRANCH_CACHE_MAX_ENTRIES);
}

export function invalidateSessionBranchCache(
  databasePath: string,
  sessionIds: readonly string[],
): void {
  const selected = new Set(uniqueStrings(sessionIds));
  for (const [key, snapshot] of sessionBranchCache) {
    if (
      key.startsWith(`${databasePath}\0`) &&
      snapshot.source &&
      selected.has(snapshot.source.sessionId)
    ) {
      sessionBranchCache.delete(key);
    }
  }
}
