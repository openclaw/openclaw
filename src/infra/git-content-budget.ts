import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Worker content reads and host-owned worktree maintenance share one child budget.
// Slots survive lifecycle resets until their owning processes have settled.
const budget = resolveGlobalSingleton(Symbol.for("openclaw.gitContentBudget"), () => ({
  active: 0,
  activeInteractive: 0,
  waiters: new Set<() => void>(),
  interactiveWaiters: new Set<() => void>(),
}));

export async function withContentGitSlot<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
  interactive = false,
): Promise<T> {
  signal?.throwIfAborted();
  const waiters = interactive ? budget.interactiveWaiters : budget.waiters;
  await new Promise<void>((resolve, reject) => {
    const start = () => {
      waiters.delete(start);
      signal?.removeEventListener("abort", abort);
      budget.active++;
      budget.activeInteractive += Number(interactive);
      resolve();
    };
    const abort = () => {
      waiters.delete(start);
      reject(toErrorObject(signal?.reason, "Git operation aborted"));
    };
    if (budget.active < 2) {
      start();
    } else {
      waiters.add(start);
      signal?.addEventListener("abort", abort, { once: true });
    }
  });
  try {
    signal?.throwIfAborted();
    return await run();
  } finally {
    // Cancellation can retire a worker before its Git process; retain the slot through cleanup.
    budget.active--;
    budget.activeInteractive -= Number(interactive);
    // Prioritize polls without starving FIFO background work or preempting active children.
    const next =
      budget.interactiveWaiters.size > 0 &&
      (budget.waiters.size === 0 || budget.activeInteractive === 0)
        ? budget.interactiveWaiters
        : budget.waiters;
    next.values().next().value?.();
  }
}
