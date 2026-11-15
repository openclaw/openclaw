import { performance } from "node:perf_hooks";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "./cancellation-policy.js";
import { getProcessCleanupBudget, type ProcessCleanupBudget } from "./cleanup-budget.js";

/** One deadline spans cancellation, receipt, native joins, and output drain. */
export function createServiceChildCleanupDeadline(params: {
  enabled: () => boolean;
  expire: () => void;
  force: () => void;
}) {
  let deadline: number | undefined;
  let startedAt: number | undefined;
  let budget: ProcessCleanupBudget | undefined;
  let expiryTimer: NodeJS.Timeout | undefined;
  let expiryPoll: NodeJS.Immediate | undefined;
  let escalationTimer: NodeJS.Timeout | undefined;
  const clear = () => {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    clearImmediate(expiryPoll);
    expiryPoll = undefined;
    clearTimeout(escalationTimer);
    escalationTimer = undefined;
  };
  const begin = (shutdownBudget?: ProcessCleanupBudget) => {
    // Shutdown may adopt cleanup already started by a receipt. Accept that
    // owner once; repeated cancellation and EOF cannot renew either budget.
    if (!params.enabled() || (deadline !== undefined && (!shutdownBudget || budget))) {
      return;
    }
    clear();
    const now = performance.now();
    startedAt ??= now;
    budget = shutdownBudget;
    deadline = budget?.deadline ?? startedAt + GRACEFUL_CANCEL_TIMEOUT_MS;
    const remainingMs = budget ? Math.max(0, deadline - now) : GRACEFUL_CANCEL_TIMEOUT_MS;
    if (budget) {
      // Leave time to observe native exit after escalation on a short stop budget.
      escalationTimer = setTimeout(
        params.force,
        Math.min(GRACEFUL_CANCEL_TIMEOUT_MS, remainingMs / 2),
      );
    }
    // A busy host can have native completion queued behind this timer.
    // Timers truncate fractional delays; round up so expiry cannot run early.
    expiryTimer = setTimeout(() => {
      expiryPoll = setImmediate(params.expire);
    }, Math.ceil(remainingMs));
  };
  return {
    get at() {
      return deadline;
    },
    get startedAt() {
      return startedAt;
    },
    get budget() {
      return budget;
    },
    begin,
    cancel(signal: "SIGTERM" | "SIGKILL") {
      const shutdownBudget = getProcessCleanupBudget();
      if (shutdownBudget || signal === "SIGKILL") {
        begin(shutdownBudget);
      }
    },
    clear,
  };
}

/** Bounded expiry report: pending joins in the message, owner identity in the cause. */
export function createCleanupExpiryError(
  pending: Record<string, boolean>,
  owner: Record<string, string | number | undefined>,
  diagnostics: { durationMs: number; escalationAfterMs?: number; signalError?: Error },
): Error {
  return new Error(
    "service child cleanup did not complete before its hard deadline; pending: " +
      JSON.stringify(pending),
    {
      // Stability bundles retain bounded Error messages, not arbitrary cause objects.
      // Keep owner attribution payload-free and the signaling failure in the error graph.
      cause: new Error(
        "service child cleanup owner: " +
          JSON.stringify({
            ...owner,
            durationMs: diagnostics.durationMs,
            escalationAfterMs: diagnostics.escalationAfterMs,
          }),
        { cause: diagnostics.signalError },
      ),
    },
  );
}
