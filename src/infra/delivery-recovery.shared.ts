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

export function createRecoveryReplayPacer(): {
  wait(deadlineMs?: number): Promise<"ready" | "deadline-exceeded">;
} {
  let lastReplayStartedAt = 0;
  let waitQueue = Promise.resolve();

  return {
    async wait(deadlineMs) {
      let releaseWaiter: () => void = () => {};
      const previousWaiter = waitQueue;
      waitQueue = new Promise<void>((resolve) => {
        releaseWaiter = resolve;
      });
      await previousWaiter;

      try {
        const now = Date.now();
        if (deadlineMs !== undefined && now >= deadlineMs) {
          return "deadline-exceeded";
        }
        // Clock rollback starts a fresh pacing epoch. Otherwise concurrent startup
        // and reconnect drains serialize here so neither can bypass the spacing floor.
        const elapsedMs = now - lastReplayStartedAt;
        const waitMs = elapsedMs < 0 ? 0 : Math.max(0, RECOVERY_REPLAY_SPACING_MS - elapsedMs);
        if (waitMs > 0) {
          const remainingBudgetMs =
            deadlineMs === undefined ? waitMs : Math.max(0, deadlineMs - now);
          await sleep(Math.min(waitMs, remainingBudgetMs));
        }
        if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
          return "deadline-exceeded";
        }
        lastReplayStartedAt = Date.now();
        return "ready";
      } finally {
        releaseWaiter();
      }
    },
  };
}
