import { sleep } from "../utils/sleep.js";

const RECOVERY_BACKOFF_MS: readonly number[] = [5_000, 25_000, 120_000, 600_000];
export const RECOVERY_REPLAY_SPACING_MS = 250;

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
// Pace only between real replay attempts and keep the wait inside the existing
// wall-clock budget so a large backlog cannot prolong startup work indefinitely.
export async function waitForRecoveryReplayPace(params: {
  hasAttemptedReplay: boolean;
  deadlineMs: number;
}): Promise<"ready" | "deadline-exceeded"> {
  if (!params.hasAttemptedReplay) {
    return "ready";
  }
  if (Date.now() >= params.deadlineMs) {
    return "deadline-exceeded";
  }
  const remainingBudgetMs = Math.max(0, params.deadlineMs - Date.now());
  await sleep(Math.min(RECOVERY_REPLAY_SPACING_MS, remainingBudgetMs));
  return Date.now() >= params.deadlineMs ? "deadline-exceeded" : "ready";
}
