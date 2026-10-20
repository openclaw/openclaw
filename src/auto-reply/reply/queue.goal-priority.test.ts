import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import {
  claimSessionControllerInput,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import type { QueueSettings } from "./queue/types.js";

let sequence = 0;
let key: string;
beforeEach(() => {
  key = `goal-priority-${++sequence}`;
});
const settings: QueueSettings = { mode: "followup", cap: 1, dropPolicy: "new", debounceMs: 0 };
const createGoal = () => ({
  ...createQueueTestRun({ prompt: "Advance", messageId: "goal-nudge" }),
  goalContinuation: { sessionId: "sess", goalId: "goal" },
});
afterEach(() => clearFollowupQueue(key));

describe("pending Goal nudge priority", () => {
  it.each(["new", "old", "summarize"] as const)(
    "lets user input displace a nudge before the %s capacity policy",
    (dropPolicy) => {
      const goal = createGoal();
      const onSettled = vi.fn();
      goal.turnAdoptionLifecycle = { onAdopted: () => {}, onSettled };
      const policy = { ...settings, dropPolicy };
      expect(enqueueFollowupRun(key, goal, policy)).toBe(true);
      const user = createQueueTestRun({ prompt: "New user instruction", messageId: "user-1" });
      expect(enqueueFollowupRun(key, user, policy)).toBe(true);
      expect(getExistingFollowupQueue(key)?.items).toEqual([user]);
      expect(getExistingFollowupQueue(key)?.droppedCount).toBe(0);
      expect(onSettled).toHaveBeenCalledOnce();
    },
  );
  it("uses the incoming delivery callback when retiring a pending nudge wakes the queue", async ({
    signal,
  }) => {
    vi.useFakeTimers();
    const goal = createGoal();
    const user = createQueueTestRun({ prompt: "New user instruction", messageId: "user-1" });
    const deliverGoal = vi.fn(async () => {});
    const deliverUser = vi.fn(async () => {});
    try {
      expect(
        enqueueFollowupRun(key, goal, { ...settings, debounceMs: 10_000 }, "none", deliverGoal),
      ).toBe(true);
      // The next request can apply a new policy while the old nudge is pending.
      expect(enqueueFollowupRun(key, user, settings, "none", deliverUser)).toBe(true);
      await withinTest(
        Promise.all([
          goal.controllerInput!.settlement.promise,
          user.controllerInput!.settlement.promise,
        ]),
        signal,
      );
      expect(deliverGoal).not.toHaveBeenCalled();
      expect(deliverUser).toHaveBeenCalledExactlyOnceWith(user);
    } finally {
      clearFollowupQueue(key);
      vi.useRealTimers();
    }
  });
  it("does not retire an in-flight goal turn", async () => {
    const goal = createGoal();
    const onSettled = vi.fn();
    goal.turnAdoptionLifecycle = { onAdopted: () => {}, onSettled };
    enqueueFollowupRun(key, goal, settings);
    const queue = getExistingFollowupQueue(key)!;
    const claim = await claimSessionControllerInput(goal);
    try {
      const user = createQueueTestRun({ prompt: "New user instruction" });
      expect(enqueueFollowupRun(key, user, settings)).toBe(true);
      expect(queue.claim).toBe(claim);
      expect(claim.sources).toEqual([goal]);
      expect(queue.items.filter((item) => !queue.inFlight.has(item))).toEqual([user]);
      expect(user.controllerInput?.phase).toBe("waiting");
      expect(onSettled).not.toHaveBeenCalled();
    } finally {
      releaseSessionControllerClaim(claim);
      await claim.settlement.promise;
    }
  });
  it("preserves the nudge when the incoming source refuses admission", () => {
    const goal = createGoal();
    enqueueFollowupRun(key, goal, settings);
    const user = createQueueTestRun({ prompt: "Unadmitted input" });
    user.turnAdoptionLifecycle = { onAdopted: () => {}, onDeferred: () => false };
    expect(enqueueFollowupRun(key, user, settings)).toBe(false);
    expect(getExistingFollowupQueue(key)?.items).toEqual([goal]);
  });
  it("deduplicates a source retry without displacing goal work", () => {
    const policy = { ...settings, cap: 2 };
    const user = createQueueTestRun({ prompt: "Original input", messageId: "user-1" });
    const goal = createGoal();
    enqueueFollowupRun(key, user, policy);
    enqueueFollowupRun(key, goal, policy);
    expect(enqueueFollowupRun(key, { ...user }, policy)).toBe(false);
    expect(getExistingFollowupQueue(key)?.items).toEqual([user, goal]);
  });
});
