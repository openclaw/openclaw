import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createQueueCase } from "./queue.case.test-support.js";
import { completeFollowupRunLifecycle, getFollowupQueueDepth } from "./queue.js";
import { createQueueTestRun as createRun } from "./queue.test-helpers.js";
import { prepareStaleFollowupDrainRetirement } from "./queue/drain.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import type { FollowupRun, QueueSettings } from "./queue/types.js";

const queues = new Set<string>();
function queueCase(settings: Partial<QueueSettings> = {}) {
  const q = createQueueCase({ mode: "followup", cap: 1, ...settings });
  queues.add(q.key);
  return q;
}
afterEach(() => {
  for (const key of queues) {
    clearFollowupQueue(key);
  }
  queues.clear();
});

describe("followup queue in-flight ownership", () => {
  it("keeps an active single delivery out of summarized overflow", async () => {
    const q = queueCase();
    const entered = createDeferred();
    const release = createDeferred();
    const activeComplete = vi.fn();
    const pendingComplete = vi.fn();
    const active = {
      ...createRun({ prompt: "active" }),
      turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: activeComplete },
    };
    try {
      expect(q.add(active)).toBe(true);
      q.start(async (run) => {
        q.calls.push(run);
        await run.turnAdoptionLifecycle?.onAdopted?.();
        if (run === active) {
          entered.resolve();
          await release.promise;
        }
        completeFollowupRunLifecycle(run);
      });
      await entered.promise;
      expect(getFollowupQueueDepth(q.key)).toBe(0);
      expect(
        q.add({
          ...createRun({ prompt: "pending" }),
          turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: pendingComplete },
        }),
      ).toBe(true);
      expect(q.enqueue({ prompt: "survivor" })).toBe(true);
      const queue = getExistingFollowupQueue(q.key);
      expect(queue?.inFlight.has(active)).toBe(true);
      expect(queue?.items.map((item) => item.prompt)).toEqual(["active", "survivor"]);
      expect(getFollowupQueueDepth(q.key)).toBe(1);
      expect(activeComplete).not.toHaveBeenCalled();
      expect(pendingComplete).not.toHaveBeenCalled();
      expect(queue?.summarySources.map((item) => item.prompt)).toEqual(["pending"]);
    } finally {
      release.resolve();
    }
    await expect.poll(() => getExistingFollowupQueue(q.key)).toBeUndefined();
    expect(activeComplete).toHaveBeenCalledOnce();
    expect(pendingComplete).toHaveBeenCalledOnce();
    expect(q.calls.at(-1)?.prompt).toBe("survivor");
  });

  it("protects a collect group and counts only active identities still present", async () => {
    const q = queueCase({ mode: "collect", cap: 50 });
    const entered = createDeferred();
    const release = createDeferred();
    const groupCompletions = [vi.fn(), vi.fn()];
    const pendingComplete = vi.fn();
    const rejectedComplete = vi.fn();
    let aggregate: FollowupRun | undefined;
    for (const [index, onSettled] of groupCompletions.entries()) {
      expect(
        q.add({
          ...createRun({
            prompt: `group-${index + 1}`,
            originatingChannel: "slack",
            originatingTo: "channel:A",
            originatingChatType: "channel",
          }),
          turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled },
        }),
      ).toBe(true);
    }
    q.start(async (run) => {
      if (!aggregate) {
        aggregate = run;
        entered.resolve();
        await release.promise;
      }
      completeFollowupRunLifecycle(run);
    });
    try {
      await entered.promise;
      const queue = getExistingFollowupQueue(q.key);
      expect(queue?.inFlight.size).toBe(2);
      expect(getFollowupQueueDepth(q.key)).toBe(0);
      const oldSettings: QueueSettings = { ...q.settings, cap: 1, dropPolicy: "old" };
      expect(
        q.add(
          {
            ...createRun({ prompt: "pending-old" }),
            turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: pendingComplete },
          },
          oldSettings,
        ),
      ).toBe(true);
      expect(q.add(createRun({ prompt: "survivor" }), oldSettings)).toBe(true);
      expect(queue?.items.map((item) => item.prompt)).toEqual(["group-1", "group-2", "survivor"]);
      expect(pendingComplete).toHaveBeenCalledOnce();
      expect(groupCompletions.map((complete) => complete.mock.calls.length)).toEqual([0, 0]);
      await aggregate?.turnAdoptionLifecycle?.onAdopted?.();
      expect(queue?.items.map((item) => item.prompt)).toEqual(["survivor"]);
      expect(queue?.inFlight.size).toBe(2);
      expect(getFollowupQueueDepth(q.key)).toBe(1);
      expect(
        q.add(
          {
            ...createRun({ prompt: "rejected-new" }),
            turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: rejectedComplete },
          },
          { ...q.settings, cap: 1, dropPolicy: "new" },
        ),
      ).toBe(false);
      expect(rejectedComplete).toHaveBeenCalledOnce();
      expect(getFollowupQueueDepth(q.key)).toBe(1);
    } finally {
      release.resolve();
    }
    await expect.poll(() => getExistingFollowupQueue(q.key)).toBeUndefined();
    expect(groupCompletions.map((complete) => complete.mock.calls.length)).toEqual([1, 1]);
  });

  it("moves pending overflow state without replaying an active summary delivery", async () => {
    const q = queueCase();
    const activeEntered = createDeferred();
    const releaseZombie = createDeferred();
    try {
      q.enqueue({ prompt: "summary-active" });
      q.enqueue({ prompt: "summary-pending" });
      q.start(async (run) => {
        q.calls.push(run);
        if (q.calls.length === 1) {
          activeEntered.resolve();
          await releaseZombie.promise;
        }
      });
      await activeEntered.promise;
      q.enqueue({ prompt: "item-pending" });
      const retire = prepareStaleFollowupDrainRetirement(q.key);
      expect(retire).toBeTypeOf("function");
      retire?.();
      await vi.waitFor(() => expect(q.calls).toHaveLength(3));
      expect(q.calls[0]?.prompt).toContain("summary-active");
      expect(q.calls[1]?.prompt).toContain("summary-pending");
      expect(q.calls[2]?.prompt).toBe("item-pending");
      releaseZombie.resolve();
      await vi.waitFor(() => expect(getExistingFollowupQueue(q.key)).toBeUndefined());
      expect(q.calls).toHaveLength(3);
    } finally {
      releaseZombie.resolve();
    }
  });
});
