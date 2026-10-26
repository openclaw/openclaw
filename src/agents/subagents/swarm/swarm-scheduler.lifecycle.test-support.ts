import { expect, vi } from "vitest";
import * as scheduler from "./swarm-scheduler.js";

let observing = false;

/** Observe native effects; cleanup retains their original graph and owner identities. */
export function observeSwarmSchedulerWork() {
  if (observing) {
    throw new Error("Previous swarm scheduler fixture cleanup is incomplete");
  }
  expect(scheduler.listSwarmRunReservationIds()).toEqual([]);
  observing = true;
  const runIds = new Set<string>();
  const owners = new Set<object | undefined>();
  const native = { ...scheduler };
  const spies: Array<{ mockRestore(): void }> = [];
  const trackReservations = <T>(run: () => T): T => {
    const before = new Set(native.listSwarmRunReservationIds());
    try {
      return run();
    } finally {
      for (const runId of native.listSwarmRunReservationIds()) {
        if (!before.has(runId)) {
          runIds.add(runId);
        }
      }
    }
  };
  spies.push(
    vi
      .spyOn(scheduler, "reserveSwarmRun")
      .mockImplementation((params) => trackReservations(() => native.reserveSwarmRun(params))),
    vi.spyOn(scheduler, "enqueueSwarmRun").mockImplementation((params) => {
      owners.add(params.lifecycleOwner);
      return trackReservations(() => native.enqueueSwarmRun(params));
    }),
    vi.spyOn(scheduler, "activateSwarmRun").mockImplementation((params) => {
      owners.add(params.lifecycleOwner);
      native.activateSwarmRun(params);
    }),
  );
  spies.push(
    vi.spyOn(scheduler, "holdQueuedSwarmRun").mockImplementation((runId) => {
      const reservation = native.holdQueuedSwarmRun(runId);
      if (reservation) {
        const bind = reservation.bindPreparation.bind(reservation);
        spies.push(
          vi.spyOn(reservation, "bindPreparation").mockImplementation((preparation) => {
            const accepted = bind(preparation);
            if (accepted) {
              owners.add(preparation.lifecycleOwner);
            }
            return accepted;
          }),
        );
      }
      return reservation;
    }),
  );
  let closed = false;
  return {
    async close() {
      if (closed) {
        return;
      }
      try {
        // Native close joins admitted launches, detached removals, and physical callback tails.
        for (const owner of owners) {
          await native.closeSwarmScheduler(owner);
        }
        // Only this fixture's restored slots and never-activated reservations remain.
        for (const runId of runIds) {
          const reservation = native.holdQueuedSwarmRun(runId);
          if (reservation) {
            reservation.withdraw();
            await reservation.release();
          } else {
            native.releaseSwarmRun(runId);
          }
        }
        expect(native.listSwarmRunReservationIds().filter((runId) => runIds.has(runId))).toEqual(
          [],
        );
        closed = true;
        observing = false;
      } finally {
        spies.toReversed().forEach((spy) => spy.mockRestore());
      }
    },
  };
}
