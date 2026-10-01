import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../../agents/admitted-run-context.js";
import { defaultRuntime } from "../../../runtime.js";
import { createQueueSettings, createQueueTestRun } from "../queue.test-helpers.js";
import { scheduleFollowupDrain } from "./drain.js";
import {
  claimNextQueuedFollowupRequestFrom,
  enqueueFollowupRun,
  parkSteerCandidate,
  reserveQueuedSteerCandidate,
} from "./enqueue.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  retireFollowupRunCancellation,
} from "./lifecycle.js";
import { prepareStaleFollowupDrainRetirement } from "./retirement.js";
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

describe("existing queued source steering reservation", () => {
  function queuedSources(key: string) {
    keys.add(key);
    const settings = createQueueSettings({ mode: "followup" });
    const sources = ["older", "selected", "newer"].map((messageId) => {
      const run = createQueueTestRun({ prompt: messageId, messageId });
      run.turnAdoptionLifecycle = { onDeferred: vi.fn(), onAdopted: vi.fn(), onSettled: vi.fn() };
      expect(enqueueFollowupRun(key, run, settings, "message-id", undefined, false)).toBe(true);
      return run;
    });
    return { sources, selected: sources[1]! };
  }

  it("does not hand a source reserved for steering to stalled-turn recovery", () => {
    const key = "promote-stalled-recovery";
    keys.add(key);
    const source = createQueueTestRun({ prompt: "stalled source", messageId: "stalled" });
    const queued = createQueueTestRun({ prompt: "queued input", messageId: "queued" });
    queued.run.terminalReplyExpectation = "required";
    queued.turnAdoptionLifecycle = { onDeferred: vi.fn() };
    const later = createQueueTestRun({ prompt: "later input", messageId: "later" });
    later.run.terminalReplyExpectation = "required";
    for (const run of [queued, later]) {
      enqueueFollowupRun(key, run, createQueueSettings(), "message-id", undefined, false);
    }
    const reservation = reserveQueuedSteerCandidate(key, queued)!;
    expect(claimNextQueuedFollowupRequestFrom(key, source)).toBeUndefined();
    expect(later.protectFromQueueOverflow).toBeUndefined();
    expect(getExistingFollowupQueue(key)?.items).toEqual([queued, later]);
    reservation.fallback();
    expect(claimNextQueuedFollowupRequestFrom(key, source)).toBe(queued);
  });

  it.each(["accepted", "rejected"] as const)(
    "preserves source identity and sibling FIFO on %s",
    async (outcome) => {
      const key = "promote-" + outcome;
      const { sources, selected } = queuedSources(key);
      const reservation = reserveQueuedSteerCandidate(key, selected)!;
      expect(reserveQueuedSteerCandidate(key, selected)).toBeUndefined();
      expect(getExistingFollowupQueue(key)?.items).toEqual(sources);
      await expect(reservation.admit()).resolves.toBe("steer");
      if (outcome === "accepted") {
        reservation.accepted(true);
        reservation.consume("consumed");
        expect(getExistingFollowupQueue(key)?.items).toEqual([sources[0], sources[2]]);
        expect(selected.turnAdoptionLifecycle?.onSettled).toHaveBeenCalledOnce();
      } else {
        reservation.fallback();
        expect(getExistingFollowupQueue(key)?.items).toEqual(sources);
        expect(selected.turnAdoptionLifecycle?.onSettled).not.toHaveBeenCalled();
      }
      expect(selected.turnAdoptionLifecycle?.onDeferred).toHaveBeenCalledOnce();
    },
  );

  it.each(["in-flight", "summary", "adopted", "retired", "cancelled"] as const)(
    "refuses %s ownership",
    async (state) => {
      const key = "promote-refused-" + state;
      const { selected } = queuedSources(key);
      const queue = getExistingFollowupQueue(key)!;
      if (state === "in-flight") {
        queue.inFlight.add(selected);
      }
      if (state === "summary") {
        queue.activeSummarySources.add(selected);
      }
      if (state === "adopted") {
        await admitFollowupRunLifecycle(selected);
      }
      if (state === "retired") {
        retireFollowupRunCancellation(selected);
      }
      if (state === "cancelled") {
        selected.abortSignal = AbortSignal.abort();
      }
      expect(reserveQueuedSteerCandidate(key, selected)).toBeUndefined();
      expect(selected.steerPending).toBeUndefined();
    },
  );

  it.each(["old", "new", "summarize"] as const)(
    "defers %s overflow while an existing source waits for acceptance and its receipt",
    async (dropPolicy) => {
      const key = "promote-overflow-reservation-" + dropPolicy;
      keys.add(key);
      const settings = createQueueSettings({ mode: "followup", cap: 1, dropPolicy });
      const selected = createQueueTestRun({ prompt: "selected", messageId: "selected" });
      const disposition = vi.fn();
      const settled = vi.fn();
      selected.onQueueDisposition = disposition;
      selected.turnAdoptionLifecycle = { onAdopted: vi.fn(), onSettled: settled };
      enqueueFollowupRun(key, selected, settings, "message-id", undefined, false);
      const reservation = reserveQueuedSteerCandidate(key, selected)!;
      const waiting = createQueueTestRun({ prompt: "while waiting", messageId: "waiting" });
      enqueueFollowupRun(key, waiting, settings, "message-id", undefined, false);
      expect(getExistingFollowupQueue(key)?.items).toEqual([selected, waiting]);
      await expect(reservation.admit()).resolves.toBe("steer");
      reservation.accepted(true);
      const accepted = createQueueTestRun({ prompt: "after acceptance", messageId: "accepted" });
      enqueueFollowupRun(key, accepted, settings, "message-id", undefined, false);
      expect(getExistingFollowupQueue(key)?.items).toEqual([selected, waiting, accepted]);
      expect(disposition).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      expect(() => reservation.assertCurrent()).not.toThrow();
      reservation.consume("consumed");
      expect(disposition).not.toHaveBeenCalled();
      expect(settled).toHaveBeenCalledOnce();
      expect(getExistingFollowupQueue(key)?.items).not.toContain(selected);
    },
  );

  it.each(["disposition", "settlement"] as const)(
    "keeps accepted custody and overflow siblings settled when a %s callback throws",
    (failure) => {
      const key = "promote-overflow-callback-" + failure;
      const { sources, selected } = queuedSources(key);
      const dropped = sources[0]!;
      const callback = vi.fn(() => {
        throw new Error("overflow callback failed");
      });
      if (failure === "disposition") {
        dropped.onQueueDisposition = callback;
      } else {
        dropped.turnAdoptionLifecycle!.onSettled = callback;
      }
      const report = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      try {
        const reservation = reserveQueuedSteerCandidate(key, selected)!;
        const newest = createQueueTestRun({ prompt: "newest", messageId: "newest" });
        enqueueFollowupRun(
          key,
          newest,
          createQueueSettings({ cap: 1, dropPolicy: "old" }),
          "message-id",
          undefined,
          false,
        );
        reservation.accepted(true);
        expect(() => reservation.consume("consumed")).not.toThrow();
        expect(selected.turnAdoptionLifecycle?.onSettled).toHaveBeenCalledOnce();
        expect(dropped.turnAdoptionLifecycle?.onSettled).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledOnce();
        expect(report).toHaveBeenCalledOnce();
        expect(getExistingFollowupQueue(key)?.items).toEqual([newest]);
      } finally {
        report.mockRestore();
      }
    },
  );

  it.each(["accepted", "rejected"] as const)(
    "does not execute a later collect group while its steering is %s",
    async (outcome) => {
      vi.useFakeTimers();
      const key = "promote-collect-snapshot-" + outcome;
      keys.add(key);
      const settings = createQueueSettings({ mode: "collect" });
      const first = createQueueTestRun({ prompt: "first group", messageId: "first" });
      const selected = createQueueTestRun({ prompt: "selected group", messageId: "selected" });
      // Same route, distinct execution contexts: the drain snapshots two collect groups.
      first.turnAdoptionLifecycle = { ownerKey: "first", onAdopted: vi.fn() };
      selected.turnAdoptionLifecycle = { ownerKey: "selected", onAdopted: vi.fn() };
      const entered = createDeferred();
      const release = createDeferred();
      const delivered: string[] = [];
      const runFollowup = async (run: FollowupRun) => {
        delivered.push(run.prompt);
        if (delivered.length === 1) {
          entered.resolve();
          await release.promise;
        }
      };
      for (const source of [first, selected]) {
        enqueueFollowupRun(key, source, settings, "message-id", runFollowup, false);
      }
      scheduleFollowupDrain(key, runFollowup);
      await entered.promise;
      const reservation = reserveQueuedSteerCandidate(key, selected)!;
      await expect(reservation.admit()).resolves.toBe("steer");
      if (outcome === "accepted") {
        reservation.accepted(true);
      }
      try {
        release.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(delivered).toHaveLength(1);
        if (outcome === "accepted") {
          reservation.consume("consumed");
        } else {
          reservation.fallback();
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(delivered).toHaveLength(outcome === "accepted" ? 1 : 2);
        if (outcome === "rejected") {
          expect(delivered[1]).toContain("selected group");
        }
      } finally {
        release.resolve();
        clearFollowupQueue(key);
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it.each(["accepted", "rejected", "waiting"] as const)(
    "settles %s steering custody transferred by stale-drain recovery",
    async (outcome) => {
      vi.useFakeTimers();
      const key = "promote-recovery-transfer-" + outcome;
      keys.add(key);
      const settings = createQueueSettings({ mode: "followup" });
      const active = createQueueTestRun({ prompt: "active", messageId: "active" });
      const selected = createQueueTestRun({ prompt: "selected", messageId: "selected" });
      const onSettled = vi.fn();
      selected.turnAdoptionLifecycle = { onAdopted: vi.fn(), onSettled };
      const entered = createDeferred();
      const release = createDeferred();
      const delivered: FollowupRun[] = [];
      const runFollowup = async (run: FollowupRun) => {
        await admitFollowupRunLifecycle(run);
        delivered.push(run);
        if (run === active) {
          entered.resolve();
          await release.promise;
        }
        completeFollowupRunLifecycle(run);
      };
      enqueueFollowupRun(key, active, settings, "message-id", runFollowup);
      await entered.promise;
      enqueueFollowupRun(key, selected, settings, "message-id", runFollowup, false);
      const reservation = reserveQueuedSteerCandidate(key, selected)!;
      const admission = reservation.admit();
      const interruptedAdmission =
        outcome === "waiting" ? expect(admission).resolves.toBe("fallback") : undefined;
      if (!interruptedAdmission) {
        await expect(admission).resolves.toBe("steer");
      }
      try {
        const retire = prepareStaleFollowupDrainRetirement(key);
        expect(retire).toBeTypeOf("function");
        retire?.();
        await interruptedAdmission;
        // Recovery transfers this exact source, not a newly admitted source with the same id.
        expect(getExistingFollowupQueue(key)?.items).toEqual([selected]);
        expect(() => reservation.assertCurrent()).toThrow("no longer current");
        if (outcome === "accepted") {
          reservation.accepted(true);
          reservation.consume("consumed");
        } else {
          reservation.fallback();
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(delivered).toEqual(outcome === "accepted" ? [active] : [active, selected]);
        expect(getExistingFollowupQueue(key)).toBeUndefined();
        expect(onSettled).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        clearFollowupQueue(key);
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it("does not let a stale reservation mutate a replacement queue", async () => {
    const key = "promote-replaced-queue";
    const { selected } = queuedSources(key);
    const old = reserveQueuedSteerCandidate(key, selected)!;
    clearFollowupQueue(key);
    const replacement = queuedSources(key);
    const current = reserveQueuedSteerCandidate(key, replacement.selected)!;
    old.accepted(true);
    old.fallback();
    old.consume("consumed");
    await expect(old.admit()).resolves.toBe("cancelled");
    expect(getExistingFollowupQueue(key)?.items).toEqual(replacement.sources);
    await expect(current.admit()).resolves.toBe("steer");
    current.fallback();
  });
});
