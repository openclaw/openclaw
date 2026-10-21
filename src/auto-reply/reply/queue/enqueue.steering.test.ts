import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../../agents/admitted-run-context.js";
import {
  beginSessionControllerSourceInjection,
  bindSessionControllerSource,
  captureSessionControllerSourceSettlement as settleSource,
  holdSessionControllerSourceWithdrawal,
  reserveSessionControllerSource,
} from "../../../sessions/session-controller.mailbox.js";
import { createQueueSettings, createQueueTestRun } from "../queue.test-helpers.js";
import { enqueueFollowupRun, reserveSteerCandidate } from "./enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./state.js";
import type { FollowupRun, QueueSettings } from "./types.js";

let key: string;
let settings: QueueSettings;
let runFollowup: (run: FollowupRun) => Promise<void>;
const reserve = (run: FollowupRun) => reserveSteerCandidate(key, run, settings, runFollowup)!;
async function admit(run: FollowupRun) {
  const reservation = reserve(run);
  await expect(reservation.admit()).resolves.toBe("steer");
  return reservation;
}
const source = (prompt: string, messageId = prompt) => createQueueTestRun({ prompt, messageId });
function observe<T>(promise: Promise<T>) {
  const called = vi.fn((value: T) => value);
  return { called, promise: promise.then(called) };
}
function authority(isCurrent: () => boolean, message: string) {
  return createAdmittedRunOperatorAuthority({
    profileId: "fixture",
    scopes: ["operator.write"],
    source: {},
    assertCurrent() {
      if (!isCurrent()) {
        throw new Error(message);
      }
    },
  });
}
function recordDelivery(count: number, active?: FollowupRun) {
  const delivered: string[] = [];
  const done = createDeferred();
  const entered = createDeferred();
  const release = createDeferred();
  runFollowup = async (run) => {
    delivered.push(run.prompt);
    if (run === active) {
      entered.resolve();
      await release.promise;
    }
    if (delivered.length === count) {
      done.resolve();
    }
  };
  return {
    delivered,
    drained: done.promise,
    activeEntered: entered.promise,
    releaseActive: () => release.resolve(),
  };
}
beforeEach(() => {
  key = `steer:${expect.getState().currentTestName}`;
  settings = createQueueSettings({ mode: "steer" });
  runFollowup = vi.fn(async () => {});
});
afterEach(() => {
  clearFollowupQueue(key);
  vi.useRealTimers();
});

it.each([true, false])(
  "retains the canonical receipt after acceptance=%s until outcome",
  async (accepted) => {
    const first = source("first");
    const lifecycle = { onAdopted: async () => {}, onSettled: vi.fn(), onAbandoned: vi.fn() };
    first.turnAdoptionLifecycle = lifecycle;
    const reservation = await admit(first);
    const input = first.controllerInput!;
    const receipt = input.injection;
    const { called: receiptSettled } = observe(receipt!.settled);
    const next = reserveSessionControllerSource(key, {
      target: input.mailbox.owner.target,
      policy: settings,
    });
    const nextInjection = beginSessionControllerSourceInjection(next);
    const { called: admittedNext, promise: nextAdmission } = observe(nextInjection.admit());
    reservation.accepted(accepted);
    // A provisional negative cannot reverse an observed positive ACK.
    reservation.accepted(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(input.injection).toBe(receipt);
    expect(receipt!.accepted).toBe(accepted);
    expect(receiptSettled).not.toHaveBeenCalled();
    expect(admittedNext).not.toHaveBeenCalled();
    expect(lifecycle.onSettled).not.toHaveBeenCalled();
    // Both accepted and indeterminate outcomes consume; neither is replayable.
    reservation.consume("consumed");
    await expect(nextAdmission).resolves.toBe(true);
    await settleSource(input);
    expect(receiptSettled).toHaveBeenCalledWith(true);
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
    expect(lifecycle.onSettled).toHaveBeenCalledOnce();
    const nextReceipt = next.injection;
    reservation.fallback();
    reservation.consume();
    expect(next.injection).toBe(nextReceipt);
    nextInjection.finish(true);
    await settleSource(next);
    expect(runFollowup).not.toHaveBeenCalled();
    expect(enqueueFollowupRun(key, first, settings, "none")).toBe(false);
  },
);

it("retains the same early source and refuses a withdrawal-held steer", async () => {
  const run = source("early source", "early");
  const input = reserveSessionControllerSource(key, {
    policy: settings,
    protocolRunId: " exact ",
  });
  bindSessionControllerSource(input, run);
  const hold = holdSessionControllerSourceWithdrawal(input);
  expect(reserveSteerCandidate(key, run, settings, runFollowup)).toBeUndefined();
  expect(input.injection).toBeUndefined();
  hold.release();
  const reservation = await admit(run);
  expect(run.controllerInput).toBe(input);
  expect(input.protocolRunId).toBe(" exact ");
  reservation.consume("consumed");
  await settleSource(input);
  expect(runFollowup).not.toHaveBeenCalled();
});

it("joins asynchronous source cleanup after native settlement and cancellation", async () => {
  const run = source("accepted source", "accepted");
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
  const reservation = await admit(run);
  reservation.accepted(true);
  cancellation.abort();
  reservation.consume("consumed");
  await cleanupStarted.promise;
  const input = run.controllerInput!;
  const { called: settled, promise: settlement } = observe(settleSource(input));
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
  const first = createQueueTestRun({ prompt: "first" });
  const second = createQueueTestRun({ prompt: "second" });
  let current = true;
  second.operatorAuthority = authority(() => current, "source authority revoked");
  const firstReservation = await admit(first);
  const secondReservation = reserve(second);
  const secondAdmission = secondReservation.admit();
  const rejected = expect(secondAdmission).rejects.toThrow("source authority revoked");
  current = false;
  firstReservation.consume("consumed");
  await rejected;
  await settleSource(second.controllerInput!);
  expect(runFollowup).not.toHaveBeenCalled();
  expect(second.controllerInput?.phase).toBe("consumed");
});

it.each(["accepted", "rejected"] as const)(
  "tries newer input after an earlier steer rejects and drains %s fallback in order",
  async (outcome) => {
    const older = source("older followup", "older");
    const first = source("first steer", "first");
    const newer = source("newer steer", "newer");
    const expected = outcome === "accepted" ? [older, first] : [older, first, newer];
    const { delivered, drained } = recordDelivery(expected.length);
    enqueueFollowupRun(key, older, settings, "message-id", runFollowup, false);
    const firstReservation = await admit(first);
    const newerReservation = reserve(newer);
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
    await drained;
    expect(delivered).toEqual(expected.map((run) => run.prompt));
    for (const run of [older, first, newer]) {
      expect(enqueueFollowupRun(key, { ...run }, settings, "message-id", runFollowup)).toBe(false);
    }
  },
);

it("cancels a middle waiter without letting later steering overtake its predecessor", async () => {
  vi.useFakeTimers();
  const first = source("first");
  const middle = source("middle");
  const last = source("last");
  const cancellation = new AbortController();
  middle.abortSignal = cancellation.signal;
  const firstReservation = reserve(first);
  const middleReservation = reserve(middle);
  const lastReservation = reserve(last);
  await expect(firstReservation.admit()).resolves.toBe("steer");
  const middleAdmission = middleReservation.admit();
  const { called: admittedLast, promise: lastAdmission } = observe(lastReservation.admit());
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
    settings = createQueueSettings({ mode: "steer", cap: 1, dropPolicy });
    const active = source("active delivery", "active");
    const first = source("first fallback", "first");
    const newer = source("newer fallback", "newer");
    let firstCurrent = true;
    if (dropPolicy === "old") {
      first.operatorAuthority = authority(() => firstCurrent, "queued source authority expired");
    }
    const disposition = vi.fn();
    newer.onQueueDisposition = disposition;
    const lifecycle = { onAdopted: () => undefined, onAbandoned: vi.fn(), onSettled: vi.fn() };
    newer.turnAdoptionLifecycle = lifecycle;
    const { activeEntered, releaseActive, drained, delivered } = recordDelivery(
      dropPolicy === "summarize" ? 3 : 2,
      active,
    );
    enqueueFollowupRun(key, active, settings, "message-id", runFollowup);
    await activeEntered;
    try {
      const firstReservation = await admit(first);
      firstReservation.fallback();
      const newerReservation = await admit(newer);
      const newerInput = newer.controllerInput!;
      const newerSettlement = settleSource(newerInput);
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
        expect(lifecycle.onAbandoned).toHaveBeenCalledOnce();
        expect(lifecycle.onSettled).toHaveBeenCalledOnce();
        await expect(newerSettlement).resolves.toBeUndefined();
      }
      releaseActive();
      await drained;
      expect(delivered).toEqual(
        dropPolicy === "new"
          ? ["active delivery", "first fallback"]
          : dropPolicy === "old"
            ? ["active delivery", "newer fallback"]
            : ["active delivery", expect.stringContaining("first fallback"), "newer fallback"],
      );
    } finally {
      releaseActive();
    }
  },
);
