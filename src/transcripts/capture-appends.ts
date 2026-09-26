import { createDeferredCore } from "../shared/deferred.js";
import type { TranscriptAppendScheduler } from "./store-worker-contract.js";

type AppendOutcome = { ok: true } | { ok: false; error: unknown };

/** Accepted speech belongs to its capture until the store has settled it. */
export function createTranscriptCaptureAppends(assertCurrent: () => void) {
  let tail = Promise.resolve();
  const pending = new Set<Promise<AppendOutcome>>();
  return {
    async run(prepare: (schedule: TranscriptAppendScheduler) => Promise<void>): Promise<void> {
      const previous = tail;
      const settled = createDeferredCore<AppendOutcome>();
      let active = true;
      // Reserve before metadata serialization can call user code or signal termination.
      pending.add(settled.promise);
      tail = previous.then(() => settled.promise).then(() => undefined);
      const assertAccepted = () => {
        if (!active) {
          throw new Error("Transcript append has already settled");
        }
        assertCurrent();
      };
      const schedule: TranscriptAppendScheduler = (write) =>
        previous.then(() => {
          assertAccepted();
          return write(assertAccepted);
        });
      const finish = (outcome: AppendOutcome) => {
        active = false;
        pending.delete(settled.promise);
        settled.resolve(outcome);
      };
      try {
        await prepare(schedule);
        finish({ ok: true });
      } catch (error) {
        finish({ ok: false, error });
        throw error;
      }
    },
    async drain(): Promise<void> {
      const outcomes = await Promise.all(pending);
      const failures = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.error]));
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Accepted transcript appends failed");
      }
    },
  };
}
