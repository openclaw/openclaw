const RECOVERY_BACKOFF_MS: readonly number[] = [5_000, 25_000, 120_000, 600_000];
const RECOVERY_RETRY_JITTER_MAX_MS = 1_000;
const RECOVERY_REPLAY_PACING_MAX_MS = 250;

export function computeBackoffMs(retryCount: number): number {
  if (retryCount <= 0) {
    return 0;
  }
  return (
    RECOVERY_BACKOFF_MS[Math.min(retryCount - 1, RECOVERY_BACKOFF_MS.length - 1)] ??
    RECOVERY_BACKOFF_MS.at(-1) ??
    0
  );
}

function normalizeDelayCeilingMs(maxDelayMs: number): number {
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) {
    return 0;
  }
  return Math.trunc(maxDelayMs);
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function computeRecoveryRetryJitterMs(
  entryId: string,
  retryCount: number,
  maxJitterMs = RECOVERY_RETRY_JITTER_MAX_MS,
): number {
  const ceiling = normalizeDelayCeilingMs(maxJitterMs);
  if (retryCount <= 0 || ceiling <= 0) {
    return 0;
  }
  return stableHash(`${entryId}:${retryCount}:retry-jitter`) % (ceiling + 1);
}

export function computeRecoveryRetryDelayMs(entryId: string, retryCount: number): number {
  return computeBackoffMs(retryCount) + computeRecoveryRetryJitterMs(entryId, retryCount);
}

export function computeRecoveryReplayPacingMs(
  entryId: string,
  retryCount: number,
  maxPacingMs = RECOVERY_REPLAY_PACING_MAX_MS,
): number {
  const ceiling = normalizeDelayCeilingMs(maxPacingMs);
  if (retryCount <= 0 || ceiling <= 0) {
    return 0;
  }
  return (stableHash(`${entryId}:${retryCount}:replay-pacing`) % ceiling) + 1;
}

export function getErrnoCode(err: unknown): string | null {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code?: unknown }).code)
    : null;
}

export function claimRecoveryEntry(entriesInProgress: Set<string>, entryId: string): boolean {
  if (entriesInProgress.has(entryId)) {
    return false;
  }
  entriesInProgress.add(entryId);
  return true;
}

export function releaseRecoveryEntry(entriesInProgress: Set<string>, entryId: string): void {
  entriesInProgress.delete(entryId);
}
