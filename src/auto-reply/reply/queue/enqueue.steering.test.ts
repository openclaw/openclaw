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
        firstReservation.fallback();
        const newerReservation = parkSteerCandidate(key, newer, settings, runFollowup)!;
        await expect(newerReservation.admit()).resolves.toBe("steer");
        expect(getExistingFollowupQueue(key)?.items).toEqual([active, first, newer]);
        expect(disposition).not.toHaveBeenCalled();
        firstCurrent = false;
        newerReservation.fallback();
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
});
