import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../../agents/admitted-run-context.js";
import {
  beginSessionControllerSourceInjection,
  bindSessionControllerSource,
  captureSessionControllerSourceSettlement as settleSource,
  holdSessionControllerSourceWithdrawal,
  reserveSessionControllerSource,
} from "../../../sessions/session-controller.mailbox.js";
import { observe, queueFixture } from "./lifecycle.test-support.js";
import { getExistingFollowupQueue } from "./state.js";
import type { FollowupRun } from "./types.js";

const queue = queueFixture("steer");
const source = (prompt: string, messageId = prompt) => queue.source(prompt, messageId);
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
  const activeGate = queue.gate();
  queue.runFollowup = async (run) => {
    delivered.push(run.prompt);
    if (run === active) {
      await activeGate.wait();
    }
    if (delivered.length === count) {
      done.resolve();
    }
  };
  return { delivered, drained: done.promise, gate: activeGate };
}
it.each([true, false])(
  "retains the canonical receipt after acceptance=%s until outcome",
  async (accepted) => {
    const first = source("first");
    const onAbandoned = vi.fn();
    const lifecycle = { onAdopted: async () => {}, onSettled: vi.fn(), onAbandoned };
    first.turnAdoptionLifecycle = lifecycle;
    const reservation = await queue.admit(first);
    const input = first.controllerInput!;
    const receipt = input.injection;
    const { called: receiptSettled } = observe(receipt!.settled);
    const next = reserveSessionControllerSource(queue.key, {
      target: input.mailbox.owner.target,
      policy: queue.settings,
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
    reservation.consume("consumed");
    await expect(nextAdmission).resolves.toBe(true);
    await settleSource(input);
    expect(receiptSettled).toHaveBeenCalledWith(true);
    expect(onAbandoned).not.toHaveBeenCalled();
    expect(lifecycle.onSettled).toHaveBeenCalledOnce();
    const nextReceipt = next.injection;
    reservation.fallback();
    reservation.consume();
    expect(next.injection).toBe(nextReceipt);
    nextInjection.finish(true);
    await settleSource(next);
    expect(queue.enqueue(first, true, "none")).toBe(false);
  },
);

it("retains the same early source and refuses a withdrawal-held steer", async () => {
  const run = source("early source", "early");
  const input = reserveSessionControllerSource(queue.key, {
    policy: queue.settings,
    protocolRunId: " exact ",
  });
  bindSessionControllerSource(input, run);
  const hold = holdSessionControllerSourceWithdrawal(input);
  expect(queue.reserve(run)).toBeUndefined();
  expect(input.injection).toBeUndefined();
  hold.release();
  const reservation = await queue.admit(run);
  expect(run.controllerInput).toBe(input);
  expect(input.protocolRunId).toBe(" exact ");
  reservation.consume("consumed");
  await settleSource(input);
});

it("joins asynchronous source cleanup after native settlement and cancellation", async () => {
  const run = source("accepted source", "accepted");
  const cancellation = new AbortController();
  const cleanup = queue.gate();
  run.abortSignal = cancellation.signal;
  run.turnAdoptionLifecycle = {
    onAdopted: async () => {},
    onSettled: cleanup.wait,
  };
  const reservation = await queue.admit(run);
  reservation.accepted(true);
  cancellation.abort();
  reservation.consume("consumed");
  await cleanup.entered;
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
  const [first, second] = [queue.source("first"), queue.source("second")];
  let current = true;
  second.operatorAuthority = authority(() => current, "source authority revoked");
  const firstReservation = await queue.admit(first);
  const secondReservation = queue.reserve(second);
  const secondAdmission = secondReservation.admit();
  const rejected = expect(secondAdmission).rejects.toThrow("source authority revoked");
  current = false;
  firstReservation.consume("consumed");
  await rejected;
  await settleSource(second.controllerInput!);
  expect(second.controllerInput?.phase).toBe("consumed");
});

it.each(["accepted", "rejected"] as const)(
  "tries newer input after an earlier steer rejects and drains %s fallback in order",
  async (outcome) => {
    const [older, first, newer] = [source("older"), source("first"), source("newer")];
    const expected = outcome === "accepted" ? [older, first] : [older, first, newer];
    const { delivered, drained } = recordDelivery(expected.length);
    queue.enqueue(older, false);
    const firstReservation = await queue.admit(first);
    const newerReservation = queue.reserve(newer);
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
      expect(queue.enqueue({ ...run })).toBe(false);
    }
  },
);

it("cancels a middle waiter without letting later steering overtake its predecessor", async () => {
  vi.useFakeTimers();
  const [first, middle, last] = [source("first"), source("middle"), source("last")];
  const cancellation = new AbortController();
  middle.abortSignal = cancellation.signal;
  const firstReservation = queue.reserve(first);
  const middleReservation = queue.reserve(middle);
  const lastReservation = queue.reserve(last);
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
});

it.each(["summarize", "new", "old"] as const)(
  "applies cap after rejected steering with drop:%s without evicting active delivery",
  async (dropPolicy) => {
    queue.settings = { ...queue.settings, cap: 1, dropPolicy };
    const [active, first, newer] = [source("active"), source("steer-a"), source("steer-b")];
    let firstCurrent = true;
    if (dropPolicy === "old") {
      first.operatorAuthority = authority(() => firstCurrent, "queued source authority expired");
    }
    const disposition = vi.fn();
    newer.onQueueDisposition = disposition;
    const onAbandoned = vi.fn();
    const lifecycle = { onAdopted: () => undefined, onAbandoned, onSettled: vi.fn() };
    newer.turnAdoptionLifecycle = lifecycle;
    const { gate, drained, delivered } = recordDelivery(dropPolicy === "summarize" ? 3 : 2, active);
    queue.enqueue(active);
    await gate.entered;
    try {
      const firstReservation = await queue.admit(first);
      firstReservation.fallback();
      const newerReservation = await queue.admit(newer);
      const newerInput = newer.controllerInput!;
      const newerSettlement = settleSource(newerInput);
      expect(getExistingFollowupQueue(queue.key)?.items).toEqual([active, first, newer]);
      expect(disposition).not.toHaveBeenCalled();
      firstCurrent = false;
      newerReservation.fallback();
      expect(getExistingFollowupQueue(queue.key)?.items).toEqual([
        active,
        dropPolicy === "new" ? first : newer,
      ]);
      expect(disposition.mock.calls).toEqual(dropPolicy === "new" ? [["queue-cap-new"]] : []);
      if (dropPolicy === "new") {
        expect(newerInput).toMatchObject({ phase: "consumed", payload: "unbound" });
        expect(onAbandoned).toHaveBeenCalledOnce();
        expect(lifecycle.onSettled).toHaveBeenCalledOnce();
        await expect(newerSettlement).resolves.toBeUndefined();
      }
      gate.resolve();
      await drained;
      expect(delivered).toEqual(
        dropPolicy === "new"
          ? ["active", "steer-a"]
          : dropPolicy === "old"
            ? ["active", "steer-b"]
            : ["active", expect.stringContaining("steer-a"), "steer-b"],
      );
    } finally {
      gate.resolve();
    }
  },
);
