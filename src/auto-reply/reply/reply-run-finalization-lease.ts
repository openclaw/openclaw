import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";

const REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS = 60_000;
export type ReplyOperationStaleReason =
  | "terminal_unreleased"
  | "finalization_stalled"
  | "no_activity"
  | "stuck_recovery";

export function formatReplyOperationResult(
  result: { kind: "completed" } | { kind: string; code: string } | null,
): string {
  if (!result) {
    return "none";
  }
  return "code" in result ? `${result.kind}:${result.code}` : result.kind;
}

type FinalizationLease = {
  begin(): void;
  beginWork(timeoutMs: number): () => void;
  clear(): void;
  recordActivity(): void;
};

type ReplyRunSettleTimer = {
  clear(): void;
  renew(timeoutMs: number): void;
  scheduleOnce(timeoutMs: number): void;
};

const activeSettleTimers = new Set<ReplyRunSettleTimer>();
const leasesByOwner = new WeakMap<object, FinalizationLease>();

export function createReplyRunSettleTimer(params: {
  canExpire: () => boolean;
  onExpire: () => void;
}): ReplyRunSettleTimer {
  let timer: NodeJS.Timeout | undefined;
  const settleTimer: ReplyRunSettleTimer = {
    clear() {
      clearTimeout(timer);
      timer = undefined;
      activeSettleTimers.delete(settleTimer);
    },
    renew(timeoutMs) {
      settleTimer.clear();
      timer = setTimeout(
        () => {
          timer = undefined;
          activeSettleTimers.delete(settleTimer);
          if (params.canExpire()) {
            params.onExpire();
          }
        },
        resolveTimerTimeoutMs(timeoutMs, REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS, 1),
      );
      timer.unref?.();
      activeSettleTimers.add(settleTimer);
    },
    scheduleOnce(timeoutMs) {
      if (!timer) {
        settleTimer.renew(timeoutMs);
      }
    },
  };
  return settleTimer;
}

export function createReplyRunFinalizationLease(params: {
  owner: object;
  canExpire: () => boolean;
  onActivity: () => void;
  onExpire: () => void;
  onFinalizationProgress: () => void;
}): FinalizationLease {
  let finalizing = false;
  let defaultDeadlineMs = 0;
  let workDeadlineMs = 0;
  let activeWork = 0;
  const settleTimer = createReplyRunSettleTimer({
    canExpire: () => finalizing && params.canExpire(),
    onExpire: params.onExpire,
  });
  const schedule = () => {
    const deadlineMs = Math.max(defaultDeadlineMs, workDeadlineMs);
    settleTimer.renew(Math.max(1, deadlineMs - Date.now()));
  };
  const recordActivity = () => {
    params.onActivity();
    if (finalizing) {
      defaultDeadlineMs = Date.now() + REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS;
      params.onFinalizationProgress();
      schedule();
    }
  };
  const lease: FinalizationLease = {
    begin() {
      if (!params.canExpire()) {
        return;
      }
      finalizing = true;
      recordActivity();
    },
    beginWork(timeoutMs) {
      activeWork += 1;
      // Overlapping tasks share the longest active grace; no per-task leases are needed.
      workDeadlineMs = Math.max(
        workDeadlineMs,
        Date.now() + resolveTimerTimeoutMs(timeoutMs, REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS, 1),
      );
      recordActivity();
      return () => {
        activeWork -= 1;
        if (activeWork <= 0) {
          activeWork = 0;
          workDeadlineMs = 0;
        }
        if (finalizing) {
          schedule();
        }
      };
    },
    clear() {
      finalizing = false;
      defaultDeadlineMs = 0;
      workDeadlineMs = 0;
      activeWork = 0;
      settleTimer.clear();
      leasesByOwner.delete(params.owner);
    },
    recordActivity,
  };
  leasesByOwner.set(params.owner, lease);
  return lease;
}

export function beginReplyOperationFinalizationWork(owner: object, timeoutMs: number): () => void {
  return leasesByOwner.get(owner)?.beginWork(timeoutMs) ?? (() => undefined);
}

export function resetReplyRunSettleTimersForTesting(): void {
  for (const timer of activeSettleTimers) {
    timer.clear();
  }
}
