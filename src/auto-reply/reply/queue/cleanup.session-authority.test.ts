import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCommandLane,
  enqueueCommandInLane,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  createQueueSettings,
  createQueueTestRun,
  installQueueRuntimeErrorSilencer,
} from "../queue.test-helpers.js";
import {
  clearSessionLifecycleQueues,
  hasSessionLifecycleQueueWork,
  prepareSessionFollowupCleanup,
} from "./cleanup.js";
import { clearFollowupDrainCallback, kickFollowupDrainIfIdle } from "./drain.js";
import { enqueueFollowupRun } from "./enqueue.js";
import { clearFollowupQueue, FOLLOWUP_QUEUES } from "./state.js";

installQueueRuntimeErrorSilencer();
const key = "agent:main:queue-stop";
const alias = "original-session";
const keys = [key, alias];
afterEach(() => {
  for (const queueKey of keys) {
    clearFollowupQueue(queueKey);
    clearFollowupDrainCallback(queueKey);
  }
});

function source(prompt: string, sessionId = "original-session") {
  const item = createQueueTestRun({ prompt });
  Object.assign(item.run, { agentId: "main", sessionKey: key, sessionId });
  const abandoned = vi.fn();
  const settled = vi.fn();
  item.turnAdoptionLifecycle = {
    admission: "cancel-only",
    onAdopted: () => {},
    onAbandoned: abandoned,
    onSettled: settled,
  };
  return { item, abandoned, settled };
}

function prepare(assertCurrent = () => {}, allIncarnations = false) {
  return prepareSessionFollowupCleanup({
    keys,
    agentId: "main",
    sessionKey: key,
    sessionId: allIncarnations ? undefined : alias,
    assertCurrent,
  });
}

describe("session-owned pending followup cleanup", () => {
  it.each([alias, undefined])(
    "matches queued work by agent and key with sessionId=%s",
    async (sessionId) => {
      const sharedKey = "global";
      const lane = "session:global";
      const owned = [
        source("current"),
        source("older", "older-session"),
        source("retargeted"),
      ] as const;
      owned[2].item.admissionSessionId = "next-session";
      const foreign = source("research");
      foreign.item.run.agentId = "research";
      for (const run of [...owned, foreign]) {
        run.item.run.sessionKey = sharedKey;
        enqueueFollowupRun(sharedKey, run.item, createQueueSettings(), "none", undefined, false);
      }
      setCommandLaneConcurrency(lane, 0);
      const commands = [alias, "older-session", "next-session"].map((id) =>
        enqueueCommandInLane(lane, async () => id, {
          sessionTarget: { agentId: "main", sessionKey: sharedKey, sessionId: id },
        }),
      );
      commands.push(
        enqueueCommandInLane(lane, async () => "research", {
          sessionTarget: { agentId: "research", sessionKey: sharedKey, sessionId: alias },
        }),
        enqueueCommandInLane(lane, async () => "untagged"),
      );
      const settled = Promise.allSettled(commands);
      const target = { keys: [sharedKey], agentId: "main", sessionKey: sharedKey, sessionId };
      try {
        expect.soft(hasSessionLifecycleQueueWork(target)).toBe(true);
        const cleared = clearSessionLifecycleQueues({ ...target, assertCurrent: () => {} });
        expect(cleared).toMatchObject({
          followupCleared: sessionId === undefined ? 3 : 1,
          laneCleared: sessionId === undefined ? 3 : 1,
        });
        expect(FOLLOWUP_QUEUES.get(sharedKey)?.items).toEqual(
          sessionId === undefined ? [foreign.item] : [owned[1].item, owned[2].item, foreign.item],
        );
        expect(hasSessionLifecycleQueueWork(target)).toBe(false);
        expect(foreign.settled).not.toHaveBeenCalled();
        setCommandLaneConcurrency(lane, 1);
        expect((await settled).map((result) => result.status)).toEqual(
          sessionId === undefined
            ? ["rejected", "rejected", "rejected", "fulfilled", "fulfilled"]
            : ["rejected", "fulfilled", "fulfilled", "fulfilled", "fulfilled"],
        );
      } finally {
        clearFollowupQueue(sharedKey);
        clearFollowupDrainCallback(sharedKey);
        clearCommandLane(lane);
        setCommandLaneConcurrency(lane, 1);
        await settled;
      }
    },
  );

  it("does not treat an absent producer agent as the default agent", () => {
    const original = source("pending admission");
    original.item.run.agentId = "";
    enqueueFollowupRun(key, original.item, createQueueSettings(), "none", undefined, false);
    expect(prepare()()).toBe(0);
    expect(original.settled).not.toHaveBeenCalled();
  });

  it("removes only captured own pending, summary and elided sources with exact accounting", () => {
    const runs = Array.from({ length: 6 }, (_, index) =>
      source(`source-${index}`, index % 2 ? "foreign-session" : alias),
    );
    for (const { item } of runs) {
      enqueueFollowupRun(key, item, createQueueSettings({ cap: 2 }), "none", undefined, false);
    }
    const queue = expectDefined(FOLLOWUP_QUEUES.get(key), "overflow queue");
    expect(queue.droppedCount).toBe(4);
    expect(queue.summaryElisions.flatMap((entry) => entry.sources)).toHaveLength(2);
    expect(prepare()()).toBe(3);
    expect(FOLLOWUP_QUEUES.get(key)).toBe(queue);
    expect(queue.items.map((item) => item.prompt)).toEqual(["source-5"]);
    expect(queue.summarySources.map((item) => item.prompt)).toEqual(["source-3"]);
    expect(queue.summaryLines).toEqual(["source-3"]);
    expect(
      queue.summaryElisions.flatMap((entry) => entry.sources.map((item) => item.prompt)),
    ).toEqual(["source-1"]);
    expect(queue.summaryElisions.flatMap((entry) => entry.summaryLines)).toEqual(["source-1"]);
    expect(queue.droppedCount).toBe(2);
    expect(queue.abortController.signal.aborted).toBe(false);
    for (const [index, run] of runs.entries()) {
      expect(run.abandoned).toHaveBeenCalledTimes(index % 2 ? 0 : 1);
      expect(run.settled).toHaveBeenCalledTimes(index % 2 ? 0 : 1);
    }
  });

  it("preserves injecting, in-flight and active-summary sources", () => {
    const runs = Array.from({ length: 5 }, (_, index) => source(`protected-${index}`));
    for (const { item } of runs) {
      enqueueFollowupRun(key, item, createQueueSettings({ cap: 2 }), "none", undefined, false);
    }
    const queue = expectDefined(FOLLOWUP_QUEUES.get(key), "protected queue");
    const activeSummary = expectDefined(queue.summarySources[0], "active summary");
    const inFlight = expectDefined(queue.items[0], "in-flight source");
    const injecting = expectDefined(queue.items[1], "injecting source");
    queue.activeSummarySources.add(activeSummary);
    queue.inFlight.add(inFlight);
    injecting.steerPending = {
      phase: "injecting",
      predecessor: Promise.resolve(true),
      settle: vi.fn(),
    };
    queue.draining = true;
    expect(prepare()()).toBe(2);
    expect(queue.items).toEqual([inFlight, injecting]);
    expect(queue.summarySources).toEqual([activeSummary]);
    expect(queue.droppedCount).toBe(1);
    expect(queue.inFlight.has(inFlight)).toBe(true);
    expect(queue.activeSummarySources.has(activeSummary)).toBe(true);
    expect(queue.draining).toBe(true);
    expect(queue.abortController.signal.aborted).toBe(false);
    expect(injecting.steerPending.settle).not.toHaveBeenCalled();
  });

  it.each(["agent", "key", "session", "admission", "new-source", "all-incarnations"] as const)(
    "respects captured authority after %s changes",
    (change) => {
      const original = source("original");
      const settings = createQueueSettings();
      enqueueFollowupRun(key, original.item, settings, "none", undefined, false);
      const queue = expectDefined(FOLLOWUP_QUEUES.get(key), "original queue");
      const allIncarnations = change === "all-incarnations";
      const cleanup = prepare(undefined, allIncarnations);
      const successor = source("successor");
      if (change === "agent") {
        original.item.run.agentId = "other";
      } else if (change === "key") {
        original.item.run.sessionKey = "agent:main:other";
      } else if (change === "session") {
        original.item.run.sessionId = "successor-session";
      } else if (change === "admission") {
        original.item.admissionSessionId = "successor-session";
      } else if (allIncarnations) {
        original.item.run.sessionId = "next-session";
        original.item.admissionSessionId = "next-admission";
      } else {
        queue.items.splice(0, 1, successor.item);
      }
      expect(cleanup()).toBe(allIncarnations ? 1 : 0);
      expect(original.settled).toHaveBeenCalledTimes(allIncarnations ? 1 : 0);
      expect(successor.settled).not.toHaveBeenCalled();
      expect(FOLLOWUP_QUEUES.get(key)?.items).toEqual(
        allIncarnations ? undefined : [change === "new-source" ? successor.item : original.item],
      );
      expect(queue.abortController.signal.aborted).toBe(false);
    },
  );

  it.each(["unchanged", "admission", "in-flight", "active-summary"] as const)(
    "follows only the recorded compact-source custody after capture (%s)",
    (change) => {
      const original = source("original");
      original.item.admissionSessionId = alias;
      const settings = createQueueSettings({ cap: 2 });
      const foreign = Array.from({ length: 4 }, (_, index) =>
        source(`foreign-${index}`, "foreign-session"),
      );
      enqueueFollowupRun(key, original.item, settings, "none", undefined, false);
      enqueueFollowupRun(
        key,
        expectDefined(foreign[0], "first foreign source").item,
        settings,
        "none",
        undefined,
        false,
      );
      const cleanup = prepare();
      for (const { item } of foreign.slice(1)) {
        enqueueFollowupRun(key, item, settings, "none", undefined, false);
      }
      const queue = expectDefined(FOLLOWUP_QUEUES.get(key), "overflowed queue");
      const elision = expectDefined(queue.summaryElisions[0], "original source elision");
      const compact = expectDefined(
        elision.sourceRefs.get(original.item),
        "recorded compact custody",
      );
      expect(compact).not.toBe(original.item);
      expect(compact.admissionSessionId).toBe(alias);
      expect(compact.turnAdoptionLifecycle).toBe(original.item.turnAdoptionLifecycle);
      if (change === "admission") {
        compact.admissionSessionId = "successor-session";
      } else if (change === "in-flight") {
        queue.inFlight.add(compact);
      } else if (change === "active-summary") {
        queue.activeSummarySources.add(compact);
      }
      expect(cleanup()).toBe(change === "unchanged" ? 1 : 0);
      expect(queue.droppedCount).toBe(change === "unchanged" ? 2 : 3);
      expect(queue.summaryElisions.flatMap((entry) => entry.sources)).toEqual(
        change === "unchanged" ? [] : [compact],
      );
      expect(queue.items.map((item) => item.prompt)).toEqual(["foreign-2", "foreign-3"]);
      expect(queue.summarySources.map((item) => item.prompt)).toEqual(["foreign-0", "foreign-1"]);
      expect(original.settled).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0);
      for (const run of foreign) {
        expect(run.settled).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves a different admission session when capture begins after overflow compaction", () => {
    const original = source("retargeted admission");
    original.item.admissionSessionId = "successor-session";
    const settings = createQueueSettings({ cap: 1 });
    for (const item of [
      original.item,
      source("foreign-1", "foreign").item,
      source("foreign-2", "foreign").item,
    ]) {
      enqueueFollowupRun(key, item, settings, "none", undefined, false);
    }
    const queue = expectDefined(FOLLOWUP_QUEUES.get(key), "elided queue");
    const compact = expectDefined(queue.summaryElisions[0]?.sources[0], "compacted original");
    expect(compact.admissionSessionId).toBe("successor-session");
    expect(prepare()()).toBe(0);
    expect(queue.summaryElisions[0]?.sources).toEqual([compact]);
    expect(queue.droppedCount).toBe(2);
    expect(original.settled).not.toHaveBeenCalled();
  });

  it("keeps the callback for untouched siblings usable after selective Stop", async () => {
    const owned = source("owned");
    const foreign = source("foreign", "foreign-session");
    const finished = createDeferredCore();
    const delivered = vi.fn(async () => {
      finished.resolve();
    });
    const settings = createQueueSettings({ mode: "followup" });
    enqueueFollowupRun(key, owned.item, settings, "none", delivered, false);
    enqueueFollowupRun(key, foreign.item, settings, "none", delivered, false);
    expect(prepare()()).toBe(1);
    kickFollowupDrainIfIdle(key);
    await finished.promise;
    expect(delivered).toHaveBeenCalledExactlyOnceWith(foreign.item);
    expect(owned.settled).toHaveBeenCalledOnce();
  });

  it.each(["steer", "abandoned"] as const)(
    "settles all detached sources after a %s callback revokes and throws, without later effects",
    (callback) => {
      const first = source("first");
      const second = source("second");
      const later = source("later queue");
      let current = true;
      const revoke = () => {
        current = false;
        throw new Error("settlement callback failed");
      };
      if (callback === "steer") {
        first.item.steerPending = {
          phase: "waiting",
          predecessor: Promise.resolve(true),
          settle: revoke,
        };
      } else {
        first.abandoned.mockImplementation(revoke);
      }
      for (const [queueKey, item] of [
        [key, first.item],
        [key, second.item],
        [alias, later.item],
      ] as const) {
        enqueueFollowupRun(queueKey, item, createQueueSettings(), "none", undefined, false);
      }
      const queue = expectDefined(FOLLOWUP_QUEUES.get(key), "accepted queue");
      const cleanup = prepare(() => {
        if (!current) {
          throw new Error("original authority revoked");
        }
      });
      expect(cleanup).toThrow("original authority revoked");
      expect(queue.items).toEqual([]);
      expect(first.abandoned).toHaveBeenCalledOnce();
      expect(first.settled).toHaveBeenCalledOnce();
      expect(second.abandoned).toHaveBeenCalledOnce();
      expect(second.settled).toHaveBeenCalledOnce();
      expect(later.settled).not.toHaveBeenCalled();
      expect(FOLLOWUP_QUEUES.get(alias)?.items).toEqual([later.item]);
      expect(FOLLOWUP_QUEUES.get(key)).toBe(queue);
      expect(queue.abortController.signal.aborted).toBe(false);
    },
  );
});
