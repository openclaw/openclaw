import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";

export function createUpdateIdentityWarningReporter(runId: string) {
  const warned = new Set<number>();
  const pending = new Map<number, string>();
  const flush = () => {
    for (const [pid, detail] of pending) {
      try {
        recordUpdateRunStep(runId, {
          step: `warning:process-start-identity:${pid}`,
          status: "completed",
          endedAtMs: Date.now(),
          detail,
        });
        pending.delete(pid);
      } catch {
        // Admission can precede the run; an old runtime cannot write after migration.
      }
    }
  };
  return {
    flush,
    warn: (pid: number, message: string) => {
      if (warned.has(pid)) {
        return;
      }
      warned.add(pid);
      console.warn(`[update] ${message}`);
      pending.set(pid, message);
      flush();
    },
  };
}
