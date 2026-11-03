import { expect } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { clearFollowupQueueForTest, createQueueSettings } from "./queue.test-helpers.js";
import { scheduleFollowupDrain } from "./queue/drain.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { admitFollowupRunLifecycle, completeFollowupRunLifecycle } from "./queue/lifecycle.js";
import { resolveFollowupAbortSignal, type FollowupRun } from "./queue/types.js";

export async function collectQueuedInputs(
  inputs: FollowupRun[],
  count = 1,
  beforeDrain?: () => void,
  onRun?: (queued: FollowupRun) => Promise<void>,
  settings: Parameters<typeof createQueueSettings>[0] = {},
) {
  const key = "queued-owner-" + crypto.randomUUID();
  const errors: unknown[] = [];
  const result: FollowupRun[] = [];
  const settlements = inputs.map((input) => {
    const settled = createDeferred();
    const lifecycle = input.turnAdoptionLifecycle;
    input.turnAdoptionLifecycle = {
      ...lifecycle,
      onAdopted: () => lifecycle?.onAdopted(),
      onSettled: () => {
        try {
          lifecycle?.onSettled?.();
        } finally {
          settled.resolve();
        }
      },
    };
    return settled.promise;
  });
  try {
    for (const input of inputs) {
      expect(
        enqueueFollowupRun(key, input, createQueueSettings(settings), "none", undefined, false),
      ).toBe(true);
    }
    beforeDrain?.();
    scheduleFollowupDrain(key, async (queued) => {
      result.push(queued);
      try {
        if (!resolveFollowupAbortSignal(queued)?.aborted) {
          await admitFollowupRunLifecycle(queued);
        }
        await onRun?.(queued);
      } catch (error) {
        errors.push(error);
      } finally {
        completeFollowupRunLifecycle(queued);
      }
    });
    await Promise.all(settlements);
    if (errors.length > 0) {
      throw errors[0];
    }
    expect(result).toHaveLength(count);
    return result;
  } finally {
    clearFollowupQueueForTest(key);
  }
}
