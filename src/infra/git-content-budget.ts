import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Worker content reads and host-owned worktree maintenance share one child budget.
// Slots survive lifecycle resets until their owning processes have settled.
const budget = resolveGlobalSingleton(Symbol.for("openclaw.gitContentBudget"), () => ({
  active: 0,
  waiters: new Set<() => void>(),
}));

export async function withContentGitSlot<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const start = () => {
      budget.waiters.delete(start);
      signal?.removeEventListener("abort", abort);
      budget.active++;
      resolve();
    };
    const abort = () => {
      budget.waiters.delete(start);
      reject(toErrorObject(signal?.reason, "Git operation aborted"));
    };
    if (budget.active < 2) {
      start();
    } else {
      budget.waiters.add(start);
      signal?.addEventListener("abort", abort, { once: true });
    }
  });
  try {
    signal?.throwIfAborted();
    return await run();
  } finally {
    // Cancellation can retire a worker before its Git process; retain the slot through cleanup.
    budget.active--;
    budget.waiters.values().next().value?.();
  }
}
