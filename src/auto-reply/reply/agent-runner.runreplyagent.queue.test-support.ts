import { expect, vi } from "vitest";
import {
  enqueueFollowupRun,
  reserveSteerCandidate,
  scheduleFollowupDrain,
  type FollowupRun,
} from "./queue.js";
import { scheduleFollowupDrain as scheduleActualFollowupDrain } from "./queue/drain.js";
import {
  enqueueFollowupRun as enqueueActualFollowupRun,
  reserveSteerCandidate as reserveActualSteerCandidate,
} from "./queue/enqueue.js";
import { clearFollowupQueue } from "./queue/state.js";

/** Real source custody with observable scheduling, not simulated queue publication. */
export function createReplyQueueFixture() {
  const sources = new Set<FollowupRun>();
  const fallback = vi.fn();
  const consume = vi.fn();
  return {
    fallback,
    consume,
    track(source: FollowupRun) {
      sources.add(source);
    },
    async settle() {
      // Join real cleanup before deleting stores or resetting the next case.
      const mailboxes = new Set(
        [...sources].flatMap((source) =>
          source.controllerInput ? [source.controllerInput.mailbox] : [],
        ),
      );
      for (const mailbox of mailboxes) {
        clearFollowupQueue(mailbox.key, mailbox);
      }
      await Promise.allSettled(
        [...sources].flatMap((source) => {
          const input = source.controllerInput;
          return !input
            ? []
            : input.claim
              ? [input.settlement.promise, input.claim.settlement.promise]
              : [input.settlement.promise];
        }),
      );
      sources.clear();
    },
    reset() {
      fallback.mockReset();
      consume.mockReset();
      vi.mocked(reserveSteerCandidate)
        .mockReset()
        .mockImplementation((...args) => {
          const reservation = reserveActualSteerCandidate(...args);
          return (
            reservation && {
              ...reservation,
              fallback: () => {
                fallback();
                reservation.fallback();
              },
              consume: (disposition) => {
                consume(disposition);
                reservation.consume(disposition);
              },
            }
          );
        });
      vi.mocked(enqueueFollowupRun).mockReset().mockImplementation(enqueueActualFollowupRun);
      vi.mocked(scheduleFollowupDrain).mockReset();
    },
    requireScheduledFollowupRunner(this: void): (source: FollowupRun) => Promise<void> {
      const scheduled = vi.mocked(scheduleFollowupDrain).mock.calls.at(-1);
      if (!scheduled) {
        throw new Error("expected a scheduled follow-up drain");
      }
      expect(scheduled[0]).toBe("main");
      return async (source) => {
        const input = source.controllerInput;
        if (!input) {
          throw new Error("expected an actually enqueued follow-up source");
        }
        scheduleActualFollowupDrain(scheduled[0], scheduled[1]);
        await input.settlement.promise;
      };
    },
  };
}
