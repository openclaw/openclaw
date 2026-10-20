import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  abortSessionControllerInput,
  captureSessionControllerSourceSettlement,
} from "../../sessions/session-controller.mailbox.js";
import {
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  getFollowupQueueDepth,
  scheduleFollowupDrain,
} from "./queue.js";
import { createQueueTestRun as createRun, createQueueSettings } from "./queue.test-helpers.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import type { FollowupRun, QueueDropPolicy, QueueSettings } from "./queue/types.js";

async function settleSources(...runs: FollowupRun[]) {
  await Promise.all(
    runs.map(async (run) => {
      const input = run.controllerInput;
      if (!input) {
        throw new Error("fixture source was never submitted");
      }
      await captureSessionControllerSourceSettlement(input);
      await input.claim?.settlement.promise;
    }),
  );
}

function trackedRun(
  prompt: string,
  onSettled: () => void,
  route: Partial<Parameters<typeof createRun>[0]> = {},
): FollowupRun {
  return {
    ...createRun({ prompt, ...route }),
    turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled },
  };
}

function blockedDrain(shouldBlock: (run: FollowupRun) => boolean, adopt = true) {
  const entered = createDeferred();
  const release = createDeferred();
  const calls: FollowupRun[] = [];
  const runFollowup = async (run: FollowupRun) => {
    calls.push(run);
    if (adopt) {
      await run.turnAdoptionLifecycle?.onAdopted?.();
    }
    if (shouldBlock(run)) {
      entered.resolve();
      await release.promise;
    }
    completeFollowupRunLifecycle(run);
  };
  return { entered, release, calls, runFollowup };
}

describe("followup queue in-flight ownership", () => {
  const keys = new Set<string>();

  afterEach(() => {
    for (const key of keys) {
      clearFollowupQueue(key);
    }
    keys.clear();
  });

  const createKey = (suffix: string) => {
    const key = `test-in-flight-${suffix}-${Date.now()}-${Math.random()}`;
    keys.add(key);
    return key;
  };

  const createSettings = (dropPolicy: QueueDropPolicy) =>
    createQueueSettings({ mode: "followup", cap: 1, dropPolicy });

  it.each(["old", "summarize"] as const)(
    "keeps an active single delivery out of %s overflow victims",
    async (dropPolicy) => {
      const key = createKey(dropPolicy);
      const activeComplete = vi.fn();
      const pendingComplete = vi.fn();
      const active = trackedRun("active", activeComplete);
      const pending = trackedRun("pending", pendingComplete);
      const survivor = createRun({ prompt: "survivor" });
      const { entered, release, calls, runFollowup } = blockedDrain((run) => run === active);

      try {
        expect(
          enqueueFollowupRun(key, active, createSettings(dropPolicy), "none", runFollowup),
        ).toBe(true);
        await entered.promise;

        expect(getFollowupQueueDepth(key)).toBe(0);
        expect(enqueueFollowupRun(key, pending, createSettings(dropPolicy), "none")).toBe(true);
        expect(enqueueFollowupRun(key, survivor, createSettings(dropPolicy), "none")).toBe(true);

        const queue = getExistingFollowupQueue(key);
        expect(queue?.inFlight.has(active)).toBe(true);
        expect(queue?.items.map((item) => item.prompt)).toEqual(["active", "survivor"]);
        expect(getFollowupQueueDepth(key)).toBe(1);
        expect(activeComplete).not.toHaveBeenCalled();
        if (dropPolicy === "old") {
          await settleSources(pending);
        }
        expect(pendingComplete).toHaveBeenCalledTimes(dropPolicy === "old" ? 1 : 0);
        expect(queue?.summarySources.map((item) => item.prompt)).toEqual(
          dropPolicy === "summarize" ? ["pending"] : [],
        );
      } finally {
        release.resolve();
      }

      await settleSources(active, pending, survivor);
      expect(getExistingFollowupQueue(key)).toBeUndefined();
      expect(activeComplete).toHaveBeenCalledOnce();
      expect(pendingComplete).toHaveBeenCalledOnce();
      expect(calls.at(-1)?.prompt).toBe("survivor");
    },
  );

  it("admits one pending item under drop:new while another item is active", async () => {
    const key = createKey("new");
    const rejectedEnqueued = vi.fn();
    const rejectedComplete = vi.fn();
    const active = createRun({ prompt: "active" });
    const pending = createRun({ prompt: "pending" });
    const rejected = trackedRun("rejected", rejectedComplete);
    rejected.turnAdoptionLifecycle!.onDeferred = rejectedEnqueued;
    const { entered, release, runFollowup } = blockedDrain((run) => run === active);

    try {
      expect(enqueueFollowupRun(key, active, createSettings("new"), "none", runFollowup)).toBe(
        true,
      );
      await entered.promise;

      expect(getFollowupQueueDepth(key)).toBe(0);
      expect(enqueueFollowupRun(key, pending, createSettings("new"), "none")).toBe(true);
      expect(enqueueFollowupRun(key, rejected, createSettings("new"), "none")).toBe(false);

      expect(getFollowupQueueDepth(key)).toBe(1);
      expect(getExistingFollowupQueue(key)?.items.map((item) => item.prompt)).toEqual([
        "active",
        "pending",
      ]);
      expect(rejectedEnqueued).not.toHaveBeenCalled();
      await settleSources(rejected);
      expect(rejectedComplete).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
    }

    await settleSources(active, pending, rejected);
    expect(getExistingFollowupQueue(key)).toBeUndefined();
  });

  it("protects a collect group and counts only active identities still present", async () => {
    const key = createKey("collect");
    const groupCompletions = [vi.fn(), vi.fn()];
    const pendingComplete = vi.fn();
    const rejectedComplete = vi.fn();
    let aggregate: FollowupRun | undefined;
    const initialSettings = createQueueSettings();
    const group = groupCompletions.map((onComplete, index) =>
      trackedRun(`group-${index + 1}`, onComplete, {
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingChatType: "channel",
      }),
    );
    const pending = trackedRun("pending-old", pendingComplete);
    const survivor = createRun({ prompt: "survivor" });
    const rejected = trackedRun("rejected-new", rejectedComplete);
    const { entered, release, runFollowup } = blockedDrain((run) => {
      if (!aggregate) {
        aggregate = run;
        return true;
      }
      return false;
    }, false);

    for (const run of group) {
      expect(enqueueFollowupRun(key, run, initialSettings, "none", undefined, false)).toBe(true);
    }
    scheduleFollowupDrain(key, runFollowup);

    try {
      await entered.promise;
      const queue = getExistingFollowupQueue(key);
      expect(queue?.inFlight.size).toBe(2);
      expect(getFollowupQueueDepth(key)).toBe(0);

      const oldSettings: QueueSettings = { ...initialSettings, cap: 1, dropPolicy: "old" };
      expect(enqueueFollowupRun(key, pending, oldSettings, "none")).toBe(true);
      expect(enqueueFollowupRun(key, survivor, oldSettings, "none")).toBe(true);

      expect(queue?.items.map((item) => item.prompt)).toEqual(["group-1", "group-2", "survivor"]);
      await settleSources(pending);
      expect(pendingComplete).toHaveBeenCalledOnce();
      expect(groupCompletions.map((complete) => complete.mock.calls.length)).toEqual([0, 0]);
      await aggregate?.turnAdoptionLifecycle?.onAdopted?.();
      expect(queue?.items.map((item) => item.prompt)).toEqual(["survivor"]);
      expect(queue?.inFlight.size).toBe(2);
      expect(getFollowupQueueDepth(key)).toBe(1);
      expect(
        enqueueFollowupRun(
          key,
          rejected,
          { ...initialSettings, cap: 1, dropPolicy: "new" },
          "none",
        ),
      ).toBe(false);
      await settleSources(rejected);
      expect(rejectedComplete).toHaveBeenCalledOnce();
      expect(getFollowupQueueDepth(key)).toBe(1);
    } finally {
      release.resolve();
    }

    await settleSources(...group, pending, survivor, rejected);
    expect(getExistingFollowupQueue(key)).toBeUndefined();
    expect(groupCompletions.map((complete) => complete.mock.calls.length)).toEqual([1, 1]);
  });

  it("retains a cancelled summary claim until raw settlement without replaying it or losing pending overflow", async () => {
    const key = createKey("summary-cancellation");
    const settings = createSettings("summarize");
    const activeEntered = createDeferred();
    const releaseActive = createDeferred();
    const calls: string[] = [];
    const active = createRun({ prompt: "summary-active" });
    const pending = createRun({ prompt: "summary-pending" });
    const tail = createRun({ prompt: "item-pending" });
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run.prompt);
      if (calls.length === 1) {
        activeEntered.resolve();
        await releaseActive.promise;
      }
    };

    try {
      enqueueFollowupRun(key, active, settings, "none", undefined, false);
      enqueueFollowupRun(key, pending, settings, "none", undefined, false);
      scheduleFollowupDrain(key, runFollowup);
      await activeEntered.promise;
      enqueueFollowupRun(key, tail, settings, "none", runFollowup);

      const input = active.controllerInput;
      if (!input?.claim) {
        throw new Error("expected an active summary claim");
      }
      const claim = input.claim;
      let settled = false;
      const settlement = settleSources(active).then(() => {
        settled = true;
      });
      expect(abortSessionControllerInput(input, new Error("summary owner stopped"))).toBe(true);
      await Promise.resolve();
      expect(input.abortSignal.aborted).toBe(true);
      expect(getExistingFollowupQueue(key)?.claim).toBe(claim);
      expect(claim.released).toBe(false);
      expect(settled).toBe(false);
      expect(calls).toHaveLength(1);

      releaseActive.resolve();
      await Promise.all([settlement, settleSources(pending, tail)]);
      expect(settled).toBe(true);
      expect(calls[0]).toContain("summary-active");
      expect(calls[1]).toContain("summary-pending");
      expect(calls[2]).toBe("item-pending");
      expect(getExistingFollowupQueue(key)).toBeUndefined();
      expect(calls).toHaveLength(3);
    } finally {
      releaseActive.resolve();
      clearFollowupQueue(key);
      await settleSources(active, pending, tail);
    }
  });
});
