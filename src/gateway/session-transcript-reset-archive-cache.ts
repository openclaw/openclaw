export type ResetArchiveCandidate = {
  archivePath: string;
  name: string;
  timestamp: number;
};

type ResetArchiveDiscoveryCacheEntry = {
  dirMtimeMs: number;
  dirSize: number;
  archives: ResetArchiveCandidate[];
};

type ResetArchiveHeaderMatchCacheEntry = {
  mtimeMs: number;
  size: number;
  matches: boolean;
};

const MAX_DISCOVERY_CACHE_ENTRIES = 2048;
const MAX_HEADER_MATCH_CACHE_ENTRIES = 4096;

export const MAX_RESET_ARCHIVE_CANDIDATES_PER_TRANSCRIPT = 128;

const discoveryCache = new Map<string, ResetArchiveDiscoveryCacheEntry>();
const headerMatchCache = new Map<string, ResetArchiveHeaderMatchCacheEntry>();

export function clearSessionTranscriptResetArchiveDiscoveryCache(): void {
  discoveryCache.clear();
  headerMatchCache.clear();
}

function deleteHeaderMatchesForArchives(archives: ResetArchiveCandidate[]): void {
  if (archives.length === 0 || headerMatchCache.size === 0) {
    return;
  }
  const archivePaths = new Set(archives.map((archive) => archive.archivePath));
  for (const cacheKey of headerMatchCache.keys()) {
    const archivePath = cacheKey.slice(cacheKey.indexOf("\0") + 1);
    if (archivePaths.has(archivePath)) {
      headerMatchCache.delete(cacheKey);
    }
  }
}

export function getResetArchiveDiscoveryCacheEntry(
  cacheKey: string,
  signature: { dirMtimeMs: number; dirSize: number },
): ResetArchiveCandidate[] | undefined {
  const cached = discoveryCache.get(cacheKey);
  if (
    !cached ||
    cached.dirMtimeMs !== signature.dirMtimeMs ||
    cached.dirSize !== signature.dirSize
  ) {
    return undefined;
  }
  discoveryCache.delete(cacheKey);
  discoveryCache.set(cacheKey, cached);
  return cached.archives;
}

export function setResetArchiveDiscoveryCacheEntry(
  cacheKey: string,
  entry: ResetArchiveDiscoveryCacheEntry,
): void {
  discoveryCache.set(cacheKey, entry);
  while (discoveryCache.size > MAX_DISCOVERY_CACHE_ENTRIES) {
    const oldestKey = discoveryCache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    const oldestEntry = discoveryCache.get(oldestKey);
    if (oldestEntry) {
      deleteHeaderMatchesForArchives(oldestEntry.archives);
    }
    discoveryCache.delete(oldestKey);
  }
}

export function getResetArchiveHeaderMatchCacheEntry(
  cacheKey: string,
  signature: { mtimeMs: number; size: number },
): boolean | undefined {
  const cached = headerMatchCache.get(cacheKey);
  if (!cached || cached.mtimeMs !== signature.mtimeMs || cached.size !== signature.size) {
    return undefined;
  }
  headerMatchCache.delete(cacheKey);
  headerMatchCache.set(cacheKey, cached);
  return cached.matches;
}

export function setResetArchiveHeaderMatchCacheEntry(
  cacheKey: string,
  entry: ResetArchiveHeaderMatchCacheEntry,
): void {
  headerMatchCache.set(cacheKey, entry);
  while (headerMatchCache.size > MAX_HEADER_MATCH_CACHE_ENTRIES) {
    const oldestKey = headerMatchCache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    headerMatchCache.delete(oldestKey);
  }
}
