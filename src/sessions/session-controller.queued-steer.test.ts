import { expect, it } from "vitest";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import { clearFollowupQueue } from "../auto-reply/reply/queue/state.js";
import {
  beginSessionControllerSourceInjection,
  holdSessionControllerSourceWithdrawal,
} from "./session-controller.mailbox.js";

it("promotes existing sources in order without freeing pending native custody or moving FIFO on refusal", async () => {
  const key = "agent:main:queued-steer-custody";
  const sources = ["older", "selected", "later"].map((messageId) =>
    createQueueTestRun({ messageId, prompt: messageId }),
  );
  for (const source of sources) {
    expect(enqueueFollowupRun(key, source, { mode: "followup" }, "none", undefined, false)).toBe(
      true,
    );
  }
  const older = sources[0]!.controllerInput!;
  const selected = sources[1]!.controllerInput!;
  const later = sources[2]!.controllerInput!;
  const entries = [...selected.mailbox.entries];
  const sequence = selected.sequence;
  const first = beginSessionControllerSourceInjection(selected, { queuedPromotion: true });
  const second = beginSessionControllerSourceInjection(later, { queuedPromotion: true });
  try {
    expect(await first.admit()).toBe(true);
    expect(
      await beginSessionControllerSourceInjection(selected, { queuedPromotion: true }).admit(),
    ).toBe(false);
    expect(() => holdSessionControllerSourceWithdrawal(selected)).toThrow();
    let successorAdmitted = false;
    const successor = second.admit().then((admitted) => {
      successorAdmitted = admitted;
      return admitted;
    });
    await Promise.resolve();
    expect(successorAdmitted).toBe(false);
    first.accepted(true);
    expect(await successor).toBe(true);
    // An ACK releases injection order, not custody or eligibility for a new turn.
    expect(selected.phase).toBe("injecting");
    expect(selected.claim).toBeUndefined();
    second.finish(false);
    first.finish(false);
    expect(selected.phase).toBe("waiting");
    expect(selected.sequence).toBe(sequence);
    expect(selected.mailbox.entries).toEqual(entries);
    expect(older.phase).toBe("waiting");
  } finally {
    first.finish(false);
    second.finish(false);
    clearFollowupQueue(key);
  }
});
