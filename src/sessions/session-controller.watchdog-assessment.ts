import type {
  ReplyBackendTurnAssessment,
  ReplyBackendTurnStatus,
} from "./session-controller.turn-status.types.js";

const ASSESSMENT_MS = 10_000;
// Identity-compared views; the watchdog passes its attempt and attached backend handle.
type AssessedAttempt = { isCurrent(): boolean };
export type WatchdogAssessmentBackend = { readonly turnStatus?: ReplyBackendTurnStatus };
type Owner = {
  current: boolean;
  attempt?: AssessedAttempt;
  backend?: WatchdogAssessmentBackend;
  sequence: number;
};
type Assessment = {
  backend: WatchdogAssessmentBackend;
  status: ReplyBackendTurnStatus;
  attempt: AssessedAttempt;
  sequence: number;
  startedAtMs: number;
  deadlineAtMs: number;
  controller: AbortController;
  captured?: ReturnType<ReplyBackendTurnStatus["capture"]>;
  result?: ReplyBackendTurnAssessment & { durationMs: number };
};

/** One private slot owned and timed by the operation watchdog, never by a plugin or registry. */
export function createWatchdogAssessment(readOwner: () => Owner, onSettled: () => void) {
  let slot: Assessment | undefined;
  const hostCurrent = (target: Assessment) => {
    try {
      const owner = readOwner();
      return (
        slot === target &&
        owner.current &&
        owner.attempt === target.attempt &&
        target.attempt.isCurrent() &&
        owner.sequence === target.sequence &&
        owner.backend === target.backend &&
        target.backend.turnStatus === target.status
      );
    } catch {
      return false;
    }
  };
  const evidenceCurrent = (target: Assessment) => {
    try {
      return !target.captured || target.captured.isCurrent();
    } catch {
      return false;
    }
  };
  // Obsolete native evidence consumes this host episode; it cannot veto ordinary recovery.
  const qualify = (
    target: Assessment,
    result: ReplyBackendTurnAssessment,
  ): ReplyBackendTurnAssessment =>
    evidenceCurrent(target) ? result : { state: "unknown", basis: "status_unsupported" };
  const clear = () => {
    const previous = slot;
    slot = undefined;
    previous?.controller.abort();
  };
  const settle = (target: Assessment, result: ReplyBackendTurnAssessment, at: number) => {
    if (!hostCurrent(target) || target.result) {
      return false;
    }
    const qualified = qualify(target, result);
    if (!hostCurrent(target)) {
      return false;
    }
    const durationMs = Math.max(0, Math.min(at - target.startedAtMs, ASSESSMENT_MS));
    target.result =
      qualified.state === "closed"
        ? { state: "closed", basis: qualified.basis, durationMs }
        : { state: "unknown", basis: qualified.basis, durationMs };
    target.controller.abort();
    return true;
  };
  return {
    clear,
    check(at: number) {
      const target = slot;
      if (!target) {
        return;
      }
      if (!hostCurrent(target)) {
        clear();
      } else if (!target.result) {
        if (!evidenceCurrent(target)) {
          settle(target, { state: "unknown", basis: "status_unsupported" }, at);
        } else if (at >= target.deadlineAtMs) {
          settle(target, { state: "unknown", basis: "timeout" }, at);
        }
      }
    },
    pendingWait() {
      return slot && !slot.result && hostCurrent(slot)
        ? { kind: "backend" as const, deadlineAtMs: slot.deadlineAtMs }
        : undefined;
    },
    result() {
      const target = slot;
      if (!target?.result || !hostCurrent(target)) {
        return undefined;
      }
      const result = { ...qualify(target, target.result), durationMs: target.result.durationMs };
      return hostCurrent(target) ? result : undefined;
    },
    captureCurrent() {
      const target = slot;
      return target && hostCurrent(target) ? () => hostCurrent(target) : undefined;
    },
    begin(at: number, executionDeadlineAtMs?: number) {
      const { attempt, backend, sequence } = readOwner();
      const status = backend?.turnStatus;
      if (slot || !attempt?.isCurrent() || !backend || !status) {
        return false;
      }
      const target: Assessment = {
        backend,
        status,
        attempt,
        sequence,
        startedAtMs: at,
        deadlineAtMs: Math.min(at + ASSESSMENT_MS, executionDeadlineAtMs ?? Infinity),
        controller: new AbortController(),
      };
      // Publish the wait before any external capture or assessment can reenter tick.
      slot = target;
      try {
        target.captured = status.capture();
        if (hostCurrent(target)) {
          if (!target.captured || !evidenceCurrent(target)) {
            settle(target, { state: "unknown", basis: "status_unsupported" }, at);
          } else if (hostCurrent(target)) {
            const finish = (result: ReplyBackendTurnAssessment) => {
              const finishedAt = Date.now();
              if (
                settle(
                  target,
                  finishedAt >= target.deadlineAtMs
                    ? { state: "unknown", basis: "timeout" }
                    : result,
                  finishedAt,
                )
              ) {
                onSettled();
              }
            };
            void target.captured
              .assess({ signal: target.controller.signal })
              .then(finish, () => finish({ state: "unknown", basis: "failed" }));
          }
        }
      } catch {
        settle(target, { state: "unknown", basis: "failed" }, Date.now());
      }
      return true;
    },
  };
}
