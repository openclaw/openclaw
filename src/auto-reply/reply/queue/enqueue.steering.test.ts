import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../../agents/admitted-run-context.js";
import { createQueueSettings, createQueueTestRun } from "../queue.test-helpers.js";
import { enqueueFollowupRun, parkSteerCandidate } from "./enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./state.js";
import type { FollowupRun } from "./types.js";

const keys = new Set<string>();
afterEach(() => {
  for (const key of keys) {
    clearFollowupQueue(key);
  }
  keys.clear();
  vi.useRealTimers();
});

describe("parked steering admission", () => {
  it.each(["accepted", "rejected"] as const)(
    "tries newer input after an earlier steer rejects and drains %s fallback in order",
    async (outcome) => {
      const key = `steer-after-rejection-${outcome}`;
      keys.add(key);
      const settings = createQueueSettings({ mode: "steer" });
      const older = createQueueTestRun({ prompt: "older followup", messageId: "older" });
      const first = createQueueTestRun({ prompt: "first steer", messageId: "first" });
      const newer = createQueueTestRun({ prompt: "newer steer", messageId: "newer" });
      const delivered: string[] = [];
      const drained = createDeferred();
      const expected = outcome === "accepted" ? [older, first] : [older, first, newer];
      const runFollowup = async (run: FollowupRun) => {
        delivered.push(run.prompt);
        if (delivered.length === expected.length) {
          drained.resolve();
        }
      };
      enqueueFollowupRun(key, older, settings, "message-id", runFollowup, false);
      const firstReservation = parkSteerCandidate(key, first, settings, runFollowup)!;
      await expect(firstReservation.admit()).resolves.toBe("steer");
      const newerReservation = parkSteerCandidate(key, newer, settings, runFollowup)!;
      const newerAdmission = newerReservation.admit();
      firstReservation.fallback();
      await expect(newerAdmission).resolves.toBe("steer");
      expect(delivered).toEqual([]);
      if (outcome === "accepted") {
        newerReservation.accepted(true);
        newerReservation.consume("consumed");
      } else {
        newerReservation.fallback();
      }
      await drained.promise;
      expect(delivered).toEqual(expected.map((run) => run.prompt));
      for (const run of [older, first, newer]) {
        expect(enqueueFollowupRun(key, { ...run }, settings, "message-id", runFollowup)).toBe(
          false,
        );
      }
    },
  );

  it("cancels a middle waiter without letting later steering overtake its predecessor", async () => {
    vi.useFakeTimers();
    const key = "steer-cancelled-middle";
    keys.add(key);
    const settings = createQueueSettings({ mode: "steer" });
    const runFollowup = vi.fn(async (_run: FollowupRun) => {});
    const first = createQueueTestRun({ prompt: "first", messageId: "first" });
    const middle = createQueueTestRun({ prompt: "middle", messageId: "middle" });
    const last = createQueueTestRun({ prompt: "last", messageId: "last" });
    const cancellation = new AbortController();
    middle.abortSignal = cancellation.signal;
    const firstReservation = parkSteerCandidate(key, first, settings, runFollowup)!;
    const middleReservation = parkSteerCandidate(key, middle, settings, runFollowup)!;
    const lastReservation = parkSteerCandidate(key, last, settings, runFollowup)!;
    await expect(firstReservation.admit()).resolves.toBe("steer");
    const middleAdmission = middleReservation.admit();
    const admittedLast = vi.fn();
    const lastAdmission = lastReservation.admit().then((result) => {
      admittedLast(result);
      return result;
    });
    cancellation.abort();
    await expect(middleAdmission).resolves.toBe("cancelled");
    middleReservation.consume();
    await vi.advanceTimersByTimeAsync(0);
    expect(admittedLast).not.toHaveBeenCalled();
    firstReservation.accepted(true);
    await expect(lastAdmission).resolves.toBe("steer");
    firstReservation.consume("consumed");
    lastReservation.accepted(true);
    lastReservation.consume("consumed");
    expect(runFollowup).not.toHaveBeenCalled();
  });

  it.each(["summarize", "new", "old"] as const)(
    "applies cap after rejected steering with drop:%s without evicting active delivery",
    async (dropPolicy) => {
      const key = `steer-fallback-cap-${dropPolicy}`;
      keys.add(key);
      const settings = createQueueSettings({ mode: "steer", cap: 1, dropPolicy });
      const active = createQueueTestRun({ prompt: "active delivery", messageId: "active" });
      const first = createQueueTestRun({ prompt: "first fallback", messageId: "first" });
      const newer = createQueueTestRun({ prompt: "newer fallback", messageId: "newer" });
      let firstCurrent = true;
      if (dropPolicy === "old") {
        first.operatorAuthority = createAdmittedRunOperatorAuthority({
          profileId: "fixture",
          scopes: ["operator.write"],
          source: {},
          assertCurrent: () => {
            if (!firstCurrent) {
              throw new Error("queued source authority expired");
            }
          },
        });
      }
      const disposition = vi.fn();
      newer.onQueueDisposition = disposition;
      const activeEntered = createDeferred();
      const releaseActive = createDeferred();
      const drained = createDeferred();
      const delivered: string[] = [];
      const runFollowup = async (run: FollowupRun) => {
        delivered.push(run.prompt);
        if (run === active) {
          activeEntered.resolve();
          await releaseActive.promise;
        }
        if (delivered.length === (dropPolicy === "summarize" ? 3 : 2)) {
          drained.resolve();
        }
      };
      enqueueFollowupRun(key, active, settings, "message-id", runFollowup);
      await activeEntered.promise;
      try {
        const firstReservation = parkSteerCandidate(key, first, settings, runFollowup)!;
        await expect(firstReservation.admit()).resolves.toBe("steer");
        expect(firstReservation.fallback()).toBe("queued");
        const newerReservation = parkSteerCandidate(key, newer, settings, runFollowup)!;
        await expect(newerReservation.admit()).resolves.toBe("steer");
        expect(getExistingFollowupQueue(key)?.items).toEqual([active, first, newer]);
        expect(disposition).not.toHaveBeenCalled();
        firstCurrent = false;
        expect(newerReservation.fallback()).toBe(dropPolicy === "new" ? "dropped" : "queued");
        expect(getExistingFollowupQueue(key)?.items).toEqual([
          active,
          dropPolicy === "new" ? first : newer,
        ]);
        expect(disposition.mock.calls).toEqual(dropPolicy === "new" ? [["queue-cap-new"]] : []);
        releaseActive.resolve();
        await drained.promise;
        expect(delivered).toEqual(
          dropPolicy === "new"
            ? ["active delivery", "first fallback"]
            : dropPolicy === "old"
              ? ["active delivery", "newer fallback"]
              : ["active delivery", expect.stringContaining("first fallback"), "newer fallback"],
        );
      } finally {
        releaseActive.resolve();
      }
    },
  );

  it.each(["summarize", "old", "new"] as const)(
    "reports a non-final fallback while a sibling steer keeps overflow deferred (drop:%s)",
    async (dropPolicy) => {
      const key = `steer-fallback-deferred-${dropPolicy}`;
      keys.add(key);
      const settings = createQueueSettings({ mode: "steer", cap: 1, dropPolicy });
      const active = createQueueTestRun({ prompt: "active delivery", messageId: "active" });
      const first = createQueueTestRun({ prompt: "first fallback", messageId: "first" });
      const newer = createQueueTestRun({ prompt: "newer fallback", messageId: "newer" });
      const firstDisposition = vi.fn();
      first.onQueueDisposition = firstDisposition;
      const activeEntered = createDeferred();
      const releaseActive = createDeferred();
      const runFollowup = async (run: FollowupRun) => {
        if (run === active) {
          activeEntered.resolve();
          await releaseActive.promise;
        }
      };
      enqueueFollowupRun(key, active, settings, "message-id", runFollowup);
      await activeEntered.promise;
      try {
        const firstReservation = parkSteerCandidate(key, first, settings, runFollowup)!;
        const newerReservation = parkSteerCandidate(key, newer, settings, runFollowup)!;
        await expect(firstReservation.admit()).resolves.toBe("steer");
        // newer is still parked, so the cap is not reconciled yet.
        expect(firstReservation.fallback()).toBe(dropPolicy === "new" ? "queued" : "at-cap");
        await expect(newerReservation.admit()).resolves.toBe("steer");
        const newerOutcome = newerReservation.fallback();
        const queue = getExistingFollowupQueue(key);
        if (dropPolicy === "new") {
          expect(newerOutcome).toBe("dropped");
          expect(queue?.items).toEqual([active, first]);
        } else {
          expect(newerOutcome).toBe("queued");
          expect(queue?.items).toEqual([active, newer]);
          expect(queue?.summarySources.includes(first)).toBe(dropPolicy === "summarize");
        }
        // drop:old reports the later eviction of the earlier fallback, which is what
        // lets its receipt be followed up; summarize keeps the content, new keeps first.
        expect(firstDisposition.mock.calls).toEqual(
          dropPolicy === "old" ? [["queue-cap-old"]] : [],
        );
      } finally {
        releaseActive.resolve();
      }
    },
  );

  it("reports a run moved into a summary elision as summarized, not dropped", async () => {
    const key = "steer-fallback-elided-summary";
    keys.add(key);
    const settings = createQueueSettings({ mode: "steer", cap: 1, dropPolicy: "summarize" });
    const active = createQueueTestRun({ prompt: "active delivery", messageId: "active" });
    const first = createQueueTestRun({ prompt: "first fallback", messageId: "first" });
    const middle = createQueueTestRun({ prompt: "middle fallback", messageId: "middle" });
    const last = createQueueTestRun({ prompt: "last fallback", messageId: "last" });
    const activeEntered = createDeferred();
    const releaseActive = createDeferred();
    const runFollowup = async (run: FollowupRun) => {
      if (run === active) {
        activeEntered.resolve();
        await releaseActive.promise;
      }
    };
    enqueueFollowupRun(key, active, settings, "message-id", runFollowup);
    await activeEntered.promise;
    try {
      const firstReservation = parkSteerCandidate(key, first, settings, runFollowup)!;
      const middleReservation = parkSteerCandidate(key, middle, settings, runFollowup)!;
      const lastReservation = parkSteerCandidate(key, last, settings, runFollowup)!;
      await expect(firstReservation.admit()).resolves.toBe("steer");
      expect(firstReservation.fallback()).toBe("at-cap");
      await expect(middleReservation.admit()).resolves.toBe("steer");
      expect(middleReservation.fallback()).toBe("at-cap");
      await expect(lastReservation.admit()).resolves.toBe("steer");
      // Settling the last park reconciles the cap: first and middle overflow into the
      // summary, and the one-line summary limit elides first's line.
      expect(lastReservation.fallback()).toBe("queued");
      const queue = getExistingFollowupQueue(key);
      expect(queue?.summarySources).toEqual([middle]);
      expect(queue?.summaryElisions.some((entry) => entry.sourceRefs.has(first))).toBe(true);
      // The disposition is read from the queue, so a repeated fallback reports it again.
      expect(firstReservation.fallback()).toBe("summarized");
      expect(middleReservation.fallback()).toBe("summarized");
      // More overflow trims the elisions to the cap and evicts first's retained copy;
      // the queue then reports a drop, which is why the summarized receipt warns that
      // older summary entries can be trimmed.
      for (const id of ["later-1", "later-2", "later-3"]) {
        enqueueFollowupRun(
          key,
          createQueueTestRun({ prompt: id, messageId: id }),
          settings,
          "message-id",
          runFollowup,
        );
      }
      expect(queue?.summaryElisions.some((entry) => entry.sourceRefs.has(first))).toBe(true);
      expect(firstReservation.fallback()).toBe("dropped");
    } finally {
      releaseActive.resolve();
    }
  });
});
