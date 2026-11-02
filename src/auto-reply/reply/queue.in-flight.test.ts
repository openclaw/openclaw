import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

let sequence = 0;
let key: string;
beforeEach(() => {
  key = `test-in-flight-${++sequence}`;
});
afterEach(() => clearFollowupQueue(key));

function expectPending(prompts: string[], depth: number) {
  expect(getExistingFollowupQueue(key)?.items.map((item) => item.prompt)).toEqual(prompts);
  expect(getFollowupQueueDepth(key)).toBe(depth);
}

async function settleSources(...runs: FollowupRun[]) {
  await Promise.all(
    runs.map(async (run) => {
      const input = run.controllerInput!;
      expect(input, "fixture source was never submitted").toBeDefined();
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
  return createRun({
    prompt,
    ...route,
    turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled },
  });
}

function blockedDrain(shouldBlock?: (run: FollowupRun) => boolean, adopt = true) {
  const entered = createDeferred();
  const release = createDeferred();
  const calls: FollowupRun[] = [];
  const runFollowup = async (run: FollowupRun) => {
    calls.push(run);
    if (adopt) {
      await run.turnAdoptionLifecycle?.onAdopted?.();
    }
    if (shouldBlock ? shouldBlock(run) : calls.length === 1) {
      entered.resolve();
      await release.promise;
    }
    completeFollowupRunLifecycle(run);
  };
  return { entered, release, calls, runFollowup };
}

describe("followup queue in-flight ownership", () => {
  const createSettings = (dropPolicy: QueueDropPolicy) =>
    createQueueSettings({ mode: "followup", cap: 1, dropPolicy });

  it.each(["old", "summarize", "new"] as const)(
    "excludes active delivery from %s overflow capacity and victims",
    async (dropPolicy) => {
      const rejectNew = dropPolicy === "new";
      const activeComplete = vi.fn();
      const pendingComplete = vi.fn();
      const incomingComplete = vi.fn();
      const onDeferred = vi.fn();
      const active = trackedRun("active", activeComplete);
      const pending = trackedRun("pending", pendingComplete);
      const incoming = trackedRun(rejectNew ? "rejected" : "survivor", incomingComplete);
      incoming.turnAdoptionLifecycle!.onDeferred = onDeferred;
      const { entered, release, calls, runFollowup } = blockedDrain((run) => run === active);
      const enqueue = (run: FollowupRun, deliver?: typeof runFollowup) =>
        enqueueFollowupRun(key, run, createSettings(dropPolicy), "none", deliver);
      try {
        expect(enqueue(active, runFollowup)).toBe(true);
        await entered.promise;
        expect(getFollowupQueueDepth(key)).toBe(0);
        expect(enqueue(pending)).toBe(true);
        expect(enqueue(incoming)).toBe(!rejectNew);
        expectPending(["active", rejectNew ? "pending" : "survivor"], 1);
        const queue = getExistingFollowupQueue(key);
        expect(queue?.inFlight.has(active)).toBe(true);
        expect(activeComplete).not.toHaveBeenCalled();
        if (dropPolicy === "old") {
          await settleSources(pending);
        }
        expect(pendingComplete).toHaveBeenCalledTimes(dropPolicy === "old" ? 1 : 0);
        expect(queue?.summarySources.map((item) => item.prompt)).toEqual(
          dropPolicy === "summarize" ? ["pending"] : [],
        );
        if (rejectNew) {
          expect(onDeferred).not.toHaveBeenCalled();
          await settleSources(incoming);
          expect(incomingComplete).toHaveBeenCalledOnce();
        }
      } finally {
        release.resolve();
      }
      await settleSources(active, pending, incoming);
      expect(getExistingFollowupQueue(key)).toBeUndefined();
      expect([activeComplete, pendingComplete].map((fn) => fn.mock.calls.length)).toEqual([1, 1]);
      expect(calls.at(-1)?.prompt).toBe(rejectNew ? "pending" : "survivor");
    },
  );

  it("protects a collect group and counts only active identities still present", async () => {
    const groupCompletions = [vi.fn(), vi.fn()];
    const pendingComplete = vi.fn();
    const rejectedComplete = vi.fn();
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
    const { entered, release, calls, runFollowup } = blockedDrain(undefined, false);

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
      await calls[0]?.turnAdoptionLifecycle?.onAdopted?.();
      expectPending(["survivor"], 1);
      expect(queue?.inFlight.size).toBe(2);
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

      const input = active.controllerInput!;
      const claim = input.claim!;
      expect(claim, "expected an active summary claim").toBeDefined();
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
