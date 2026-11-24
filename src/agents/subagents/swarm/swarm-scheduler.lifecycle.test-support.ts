import { expect, vi } from "vitest";
import * as scheduler from "./swarm-scheduler.js";

export function enqueueSwarmRun(
  params: Parameters<typeof scheduler.reserveSwarmRun>[0] &
    Parameters<typeof scheduler.activateSwarmRun>[0],
): void {
  if (!scheduler.reserveSwarmRun(params)) {
    throw new Error(`swarm scheduler run already exists: ${params.runId}`);
  }
  scheduler.activateSwarmRun(params);
}

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
  const reserve = scheduler.reserveSwarmRun;
  const activate = scheduler.activateSwarmRun;
  const hold = scheduler.holdQueuedSwarmRun;
  const close = scheduler.closeSwarmScheduler;
  const list = scheduler.listSwarmRunReservationIds;
  const release = scheduler.releaseSwarmRun;
  const preparationSpies: Array<{ mockRestore(): void }> = [];
  const recordNewReservations = (before: Set<string>) => {
    for (const runId of list()) {
      if (!before.has(runId)) {
        runIds.add(runId);
      }
    }
  };
  const reservations = vi.spyOn(scheduler, "reserveSwarmRun").mockImplementation((params) => {
    const before = new Set(list());
    try {
      return reserve(params);
    } finally {
      recordNewReservations(before);
    }
  });
  const activations = vi.spyOn(scheduler, "activateSwarmRun").mockImplementation((params) => {
    owners.add(params.lifecycleOwner);
    activate(params);
  });
  const holds = vi.spyOn(scheduler, "holdQueuedSwarmRun").mockImplementation((runId) => {
    const reservation = hold(runId);
    if (reservation) {
      const bind = reservation.bindPreparation.bind(reservation);
      preparationSpies.push(
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
  });
  let closed = false;
  return {
    async close() {
      if (closed) {
        return;
      }
      try {
        // Native close joins admitted launches, detached removals, and physical callback tails.
        for (const owner of owners) {
          await close(owner);
        }
        // Only this fixture's restored slots and never-activated reservations remain.
        for (const runId of runIds) {
          const reservation = hold(runId);
          if (reservation) {
            reservation.withdraw();
            await reservation.release();
          } else {
            release(runId);
          }
        }
        expect(list().filter((runId) => runIds.has(runId))).toEqual([]);
        closed = true;
        observing = false;
      } finally {
        preparationSpies.forEach((spy) => spy.mockRestore());
        holds.mockRestore();
        activations.mockRestore();
        reservations.mockRestore();
      }
    },
  };
}
