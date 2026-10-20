import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../../agents/admitted-run-context.js";
import {
  beginSessionControllerSourceInjection,
  bindSessionControllerSource,
  captureSessionControllerSourceSettlement,
  holdSessionControllerSourceWithdrawal,
  reserveSessionControllerSource,
} from "../../../sessions/session-controller.mailbox.js";
import { createQueueSettings, createQueueTestRun } from "../queue.test-helpers.js";
import { enqueueFollowupRun, reserveSteerCandidate } from "./enqueue.js";
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
  it.each([true, false])(
    "retains the canonical receipt after acceptance=%s until outcome",
    async (accepted) => {
      const key = `steer-native-settlement-${accepted}`;
      keys.add(key);
      const settings = createQueueSettings({ mode: "steer" });
      const first = createQueueTestRun({ prompt: "first", messageId: "first" });
      const settled = vi.fn();
      const abandoned = vi.fn();
      first.turnAdoptionLifecycle = {
        onAdopted: async () => {},
        onSettled: settled,
        onAbandoned: abandoned,
      };
      const runFollowup = vi.fn(async (_run: FollowupRun) => {});
      const reservation = reserveSteerCandidate(key, first, settings, runFollowup)!;
      expect(await reservation.admit()).toBe("steer");
      const input = first.controllerInput!;
      const receipt = input.injection;
      const receiptSettled = vi.fn();
      void receipt!.settled.then(receiptSettled);
      const next = reserveSessionControllerSource(key, {
        target: input.mailbox.owner.target,
        policy: settings,
      });
      const nextInjection = beginSessionControllerSourceInjection(next);
      const admittedNext = vi.fn();
      const nextAdmission = nextInjection.admit().then((admitted) => {
        admittedNext(admitted);
        return admitted;
      });
      reservation.accepted(accepted);
      // A provisional negative cannot reverse an observed positive ACK.
      reservation.accepted(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(input.injection).toBe(receipt);
      expect(receipt!.accepted).toBe(accepted);
      expect(receiptSettled).not.toHaveBeenCalled();
      expect(admittedNext).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      // Both accepted and indeterminate outcomes consume; neither is replayable.
      reservation.consume("consumed");
      await expect(nextAdmission).resolves.toBe(true);
      await captureSessionControllerSourceSettlement(input);
      expect(receiptSettled).toHaveBeenCalledWith(true);
      expect(abandoned).not.toHaveBeenCalled();
      expect(settled).toHaveBeenCalledOnce();
      const nextReceipt = next.injection;
      reservation.fallback();
      reservation.consume();
      expect(next.injection).toBe(nextReceipt);
      nextInjection.finish(true);
      await captureSessionControllerSourceSettlement(next);
      expect(runFollowup).not.toHaveBeenCalled();
      expect(enqueueFollowupRun(key, first, settings, "none")).toBe(false);
    },
  );

  it("retains the same early source and refuses a withdrawal-held steer", async () => {
    const key = "steer-held-early-source";
    keys.add(key);
    const settings = createQueueSettings({ mode: "steer" });
    const run = createQueueTestRun({ prompt: "early source", messageId: "early" });
    const input = reserveSessionControllerSource(key, {
      policy: settings,
      protocolRunId: " exact ",
    });
    bindSessionControllerSource(input, run);
    const hold = holdSessionControllerSourceWithdrawal(input);
    const runFollowup = vi.fn(async (_run: FollowupRun) => {});
    expect(reserveSteerCandidate(key, run, settings, runFollowup)).toBeUndefined();
    expect(input.injection).toBeUndefined();
    hold.release();
    const reservation = reserveSteerCandidate(key, run, settings, runFollowup)!;
    expect(run.controllerInput).toBe(input);
    expect(input.protocolRunId).toBe(" exact ");
    expect(await reservation.admit()).toBe("steer");
    reservation.consume("consumed");
    await captureSessionControllerSourceSettlement(input);
    expect(runFollowup).not.toHaveBeenCalled();
  });

  it("joins asynchronous source cleanup after native settlement and cancellation", async () => {
    const key = "steer-async-source-cleanup";
    keys.add(key);
    const settings = createQueueSettings({ mode: "steer" });
    const run = createQueueTestRun({ prompt: "accepted source", messageId: "accepted" });
    const cancellation = new AbortController();
    const cleanup = createDeferred();
    const cleanupStarted = createDeferred();
    run.abortSignal = cancellation.signal;
    run.turnAdoptionLifecycle = {
      onAdopted: async () => {},
      onSettled: () => {
        cleanupStarted.resolve();
        return cleanup.promise;
      },
    };
    const reservation = reserveSteerCandidate(key, run, settings, async () => {})!;
    expect(await reservation.admit()).toBe("steer");
    reservation.accepted(true);
    cancellation.abort();
    reservation.consume("consumed");
    await cleanupStarted.promise;
    const input = run.controllerInput!;
    const settled = vi.fn();
    const settlement = captureSessionControllerSourceSettlement(input).then(settled);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(input.mailbox.entries).toContain(input);
    cleanup.resolve();
    await settlement;
    expect(settled).toHaveBeenCalledOnce();
    expect(input.mailbox.entries).not.toContain(input);
  });

  it("rechecks channel execution authority after waiting for native settlement", async () => {
    const key = "steer-post-wait-authority";
    keys.add(key);
    const settings = createQueueSettings({ mode: "steer" });
    const runFollowup = vi.fn(async (_run: FollowupRun) => {});
    const first = createQueueTestRun({ prompt: "first" });
    const second = createQueueTestRun({ prompt: "second" });
    let current = true;
    second.operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "fixture",
      scopes: ["operator.write"],
      source: {},
      assertCurrent() {
        if (!current) {
          throw new Error("source authority revoked");
        }
      },
    });
    const firstReservation = reserveSteerCandidate(key, first, settings, runFollowup)!;
    expect(await firstReservation.admit()).toBe("steer");
    const secondReservation = reserveSteerCandidate(key, second, settings, runFollowup)!;
    const secondAdmission = secondReservation.admit();
    const rejected = expect(secondAdmission).rejects.toThrow("source authority revoked");
    current = false;
    firstReservation.consume("consumed");
    await rejected;
    await captureSessionControllerSourceSettlement(second.controllerInput!);
    expect(runFollowup).not.toHaveBeenCalled();
    expect(second.controllerInput?.phase).toBe("consumed");
  });

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
      const firstReservation = reserveSteerCandidate(key, first, settings, runFollowup)!;
      await expect(firstReservation.admit()).resolves.toBe("steer");
      const newerReservation = reserveSteerCandidate(key, newer, settings, runFollowup)!;
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
    const firstReservation = reserveSteerCandidate(key, first, settings, runFollowup)!;
    const middleReservation = reserveSteerCandidate(key, middle, settings, runFollowup)!;
    const lastReservation = reserveSteerCandidate(key, last, settings, runFollowup)!;
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
    // Native acceptance fixes the predecessor's order; its commit may need later input.
    firstReservation.accepted(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(admittedLast).toHaveBeenCalledExactlyOnceWith("steer");
    firstReservation.consume("consumed");
    await expect(lastAdmission).resolves.toBe("steer");
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
      const abandoned = vi.fn();
      const settled = vi.fn();
      newer.onQueueDisposition = disposition;
      newer.turnAdoptionLifecycle = {
        onAdopted: () => undefined,
        onAbandoned: abandoned,
        onSettled: settled,
      };
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
        const firstReservation = reserveSteerCandidate(key, first, settings, runFollowup)!;
        await expect(firstReservation.admit()).resolves.toBe("steer");
        firstReservation.fallback();
        const newerReservation = reserveSteerCandidate(key, newer, settings, runFollowup)!;
        await expect(newerReservation.admit()).resolves.toBe("steer");
        const newerInput = newer.controllerInput!;
        const newerSettlement = captureSessionControllerSourceSettlement(newerInput);
        expect(getExistingFollowupQueue(key)?.items).toEqual([active, first, newer]);
        expect(disposition).not.toHaveBeenCalled();
        firstCurrent = false;
        newerReservation.fallback();
        expect(getExistingFollowupQueue(key)?.items).toEqual([
          active,
          dropPolicy === "new" ? first : newer,
        ]);
        expect(disposition.mock.calls).toEqual(dropPolicy === "new" ? [["queue-cap-new"]] : []);
        if (dropPolicy === "new") {
          expect(newerInput).toMatchObject({ phase: "consumed", payload: "unbound" });
          expect(abandoned).toHaveBeenCalledOnce();
          expect(settled).toHaveBeenCalledOnce();
          await expect(newerSettlement).resolves.toBeUndefined();
        }
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
