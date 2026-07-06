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
// Pace only between real replay attempts; backoff/max-retry skips must not spend this budget.
export async function waitForRecoveryReplayPace(params: {
  attemptedReplayCount: number;
  deadlineMs: number;
}): Promise<"ready" | "deadline-exceeded"> {
  if (params.attemptedReplayCount <= 0) {
    return "ready";
  }
  const remainingMs = params.deadlineMs - Date.now();
  if (remainingMs <= 0) {
    return "deadline-exceeded";
  }
  await sleep(Math.min(RECOVERY_REPLAY_SPACING_MS, remainingMs));
  return Date.now() >= params.deadlineMs ? "deadline-exceeded" : "ready";
}
