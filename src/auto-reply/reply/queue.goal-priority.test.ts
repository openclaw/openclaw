import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import {
  claimSessionControllerInput,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import { createQueueTestRun as createRun, createQueueSettings } from "./queue.test-helpers.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import type { FollowupRun } from "./queue/types.js";

let sequence = 0;
let key: string;
beforeEach(() => {
  key = `goal-priority-${++sequence}`;
});
const settings = createQueueSettings({ mode: "followup", cap: 1, dropPolicy: "new" });
const createGoal = () =>
  createRun({
    prompt: "Advance",
    messageId: "goal-nudge",
    goalContinuation: { sessionId: "sess", goalId: "goal" },
  });
const enqueue = (run: FollowupRun, policy = settings) => enqueueFollowupRun(key, run, policy);
afterEach(() => {
  clearFollowupQueue(key);
  vi.useRealTimers();
});

it.each(["new", "old", "summarize"] as const)(
  "lets user input displace a nudge before the %s capacity policy",
  (dropPolicy) => {
    const onSettled = vi.fn();
    const goal = createGoal();
    goal.turnAdoptionLifecycle = { onAdopted: () => {}, onSettled };
    const policy = { ...settings, dropPolicy };
    expect(enqueue(goal, policy)).toBe(true);
    const user = createRun({ prompt: "New user instruction", messageId: "user-1" });
    expect(enqueue(user, policy)).toBe(true);
    const queue = getExistingFollowupQueue(key);
    expect([queue?.items, queue?.droppedCount]).toEqual([[user], 0]);
    expect(onSettled).toHaveBeenCalledOnce();
  },
);
it("wakes the Goal queue with the incoming user's callback", async ({ signal }) => {
  vi.useFakeTimers();
  const goal = createGoal();
  const user = createRun({ prompt: "New user instruction", messageId: "user-1" });
  const deliverGoal = vi.fn(async () => {});
  const deliverUser = vi.fn(async () => {});
  expect(
    enqueueFollowupRun(key, goal, { ...settings, debounceMs: 10_000 }, "none", deliverGoal),
  ).toBe(true);
  expect(enqueueFollowupRun(key, user, settings, "none", deliverUser)).toBe(true);
  await withinTest(
    Promise.all([goal, user].map((run) => run.controllerInput!.settlement.promise)),
    signal,
  );
  expect(deliverGoal).not.toHaveBeenCalled();
  expect(deliverUser).toHaveBeenCalledExactlyOnceWith(user);
});
it("does not retire an in-flight goal turn", async () => {
  const onSettled = vi.fn();
  const goal = createGoal();
  goal.turnAdoptionLifecycle = { onAdopted: () => {}, onSettled };
  enqueue(goal);
  const queue = getExistingFollowupQueue(key)!;
  const claim = await claimSessionControllerInput(goal);
  try {
    const user = createRun({ prompt: "New user instruction" });
    expect(enqueue(user)).toBe(true);
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
  enqueue(goal);
  const user = createRun({ prompt: "Unadmitted input" });
  user.turnAdoptionLifecycle = { onAdopted: () => {}, onDeferred: () => false };
  expect(enqueue(user)).toBe(false);
  expect(getExistingFollowupQueue(key)?.items).toEqual([goal]);
});
it("deduplicates a source retry without displacing goal work", () => {
  const policy = { ...settings, cap: 2 };
  const user = createRun({ prompt: "Original input", messageId: "user-1" });
  const goal = createGoal();
  enqueue(user, policy);
  enqueue(goal, policy);
  expect(enqueue({ ...user }, policy)).toBe(false);
  expect(getExistingFollowupQueue(key)?.items).toEqual([user, goal]);
});
