// Records pre-activation phase timing so validation-phase cost stays attributable.
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateCommandOptions } from "./shared.js";

/**
 * Pre-activation work runs after candidate validation is recorded, so its cost was
 * invisible: the validation phase's recorded total exceeded the sum of its recorded
 * steps by a wide margin, and the unaccounted remainder had no owner.
 *
 * Callers mark each phase boundary; consecutive marks partition the timeline, so a
 * phase's duration runs from its own mark to the next one (or to `flush`). That keeps
 * attribution to one statement per phase and also captures the small statements
 * between phases, which previously fell into the unaccounted remainder.
 *
 * Attribution only: measurement is in-memory timestamps, and a ledger refusal must
 * never fail the update, so the write stays guarded.
 */
export function createActivationPhaseRecorder(run: UpdateCommandOptions["run"]): {
  mark: (name: string) => void;
  flush: () => void;
} {
  let open: { name: string; startedAtMs: number } | undefined;
  const write = (name: string, startedAtMs: number, endedAtMs: number) => {
    if (!run) {
      return;
    }
    try {
      recordUpdateRunStep(
        run.runId,
        {
          step: `activate:${name}`,
          status: "completed",
          startedAtMs,
          endedAtMs,
          detail: `${((endedAtMs - startedAtMs) / 1000).toFixed(1)}s`,
        },
        { env: run.env },
      );
    } catch {
      // Timings are advisory; the activation itself is unaffected.
    }
  };
  const flush = () => {
    if (open) {
      write(open.name, open.startedAtMs, Date.now());
      open = undefined;
    }
  };
  const mark = (name: string) => {
    const now = Date.now();
    if (open) {
      write(open.name, open.startedAtMs, now);
    }
    open = { name, startedAtMs: now };
  };
  return { mark, flush };
}
