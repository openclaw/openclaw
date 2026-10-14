import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  it("does not retire an in-flight goal turn", () => {
    const goal = createGoal();
    enqueueFollowupRun(key, goal, settings);
    const queue = getExistingFollowupQueue(key)!;
    queue.inFlight.add(goal);
    const user = createQueueTestRun({ prompt: "New user instruction" });
    expect(enqueueFollowupRun(key, user, settings)).toBe(true);
    expect(queue.items).toEqual([goal, user]);
    queue.inFlight.delete(goal);
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
