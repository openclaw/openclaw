const RECOVERY_BACKOFF_MS: readonly number[] = [5_000, 25_000, 120_000, 600_000];
export const RECOVERY_REPLAY_SPACING_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

// Startup recovery can find many already-eligible entries after an outage.
// Pace only between real replay attempts; the pacing sleep itself must not consume
// the recovery budget and strand an otherwise eligible backlog tail.
export async function waitForRecoveryReplayPace(params: {
  attemptedReplayCount: number;
  deadlineMs: number;
  pacedDelayMs: number;
}): Promise<{ status: "ready"; sleptMs: number } | { status: "deadline-exceeded" }> {
  if (params.attemptedReplayCount <= 0) {
    return { status: "ready", sleptMs: 0 };
  }
  if (Date.now() >= params.deadlineMs + params.pacedDelayMs) {
    return { status: "deadline-exceeded" };
  }
  const sleepStartedAt = Date.now();
  await sleep(RECOVERY_REPLAY_SPACING_MS);
  return { status: "ready", sleptMs: Math.max(0, Date.now() - sleepStartedAt) };
}
