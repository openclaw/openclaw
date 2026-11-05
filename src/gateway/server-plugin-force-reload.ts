import { setTimeout as delay } from "node:timers/promises";
import {
  type CapturedPluginMaintenanceContinuation,
  type PluginMaintenanceOutcome,
  capturePluginMaintenanceContinuation,
} from "../agents/plugin-maintenance-continuation.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import type { PluginReplacementOutcome } from "../plugins/plugin-replacement-operation.js";

const log = createSubsystemLogger("gateway/plugin-maintenance");

/** One reload's bounded, in-memory handoff; reservation and physical leases stay plugin-owned. */
export function createPluginForceReload(
  assertMaintenanceCurrent: () => void,
  capture: typeof capturePluginMaintenanceContinuation = capturePluginMaintenanceContinuation,
) {
  const continuations = new Map<object, CapturedPluginMaintenanceContinuation>();
  let prepared = false;
  let drainingInstances: readonly PluginInstanceHandle[] = [];
  let interrupted = false;
  const ownersOf = (instances: readonly PluginInstanceHandle[]) =>
    new Set(instances.flatMap((instance) => [...instance.retainedWorkOwners()]));
  const cancelPrepared = () => {
    for (const continuation of continuations.values()) {
      continuation.cancel();
    }
    continuations.clear();
  };
  return {
    drain: async (
      instances: readonly PluginInstanceHandle[],
      signal: AbortSignal,
    ): Promise<void> => {
      if (prepared) {
        return;
      }
      prepared = true;
      drainingInstances = instances;
      log.info(
        `Preparing force reload for ${ownersOf(instances).size} retained conversation owner(s).`,
      );
      try {
        assertMaintenanceCurrent();
        // Reservation rejects fresh acquisition. Reconcile once for work already admitted
        // before it; later unbound holders retain the ordinary bounded drain behavior.
        for (let pass = 0; pass < 2; pass++) {
          for (const owner of ownersOf(instances)) {
            if (continuations.has(owner)) {
              continue;
            }
            signal.throwIfAborted();
            assertMaintenanceCurrent();
            const preparation = capture(owner);
            if (!preparation) {
              throw new Error(
                "Cannot force reload: selected plugin work has no supported native conversation continuation. Wait for that work to finish, then retry.",
              );
            }
            continuations.set(owner, await preparation);
            assertMaintenanceCurrent();
          }
        }
        if ([...ownersOf(instances)].some((owner) => !continuations.has(owner))) {
          throw new Error(
            "Plugin work changed while preparing maintenance; retry after it settles.",
          );
        }
        log.info(
          `Captured ${continuations.size} original-requester continuation(s) for force reload.`,
        );
        // Eligible cooperative handover runs first, within the caller's existing drain budget.
        if (continuations.size > 0) {
          await delay(250, undefined, { signal });
        }
        signal.throwIfAborted();
        assertMaintenanceCurrent();
        const remaining = ownersOf(instances);
        for (const [owner, continuation] of continuations) {
          if (!remaining.has(owner)) {
            continuation.cancel();
            continuations.delete(owner);
          }
        }
        interrupted = true;
        log.info(
          `Interrupting ${continuations.size} retaining conversation owner(s) for maintenance.`,
        );
        await Promise.all(
          [...continuations.values()].map((continuation) => {
            assertMaintenanceCurrent();
            return continuation.interrupt(assertMaintenanceCurrent);
          }),
        );
        // Slot-clear, an abort notification, or writer fencing is not producer settlement.
        await Promise.all([...continuations.values()].map((continuation) => continuation.settled));
      } catch (error) {
        if (!interrupted) {
          cancelPrepared();
        }
        throw error;
      }
    },
    complete<T>(
      reload: Promise<T>,
      pluginIds: Iterable<string>,
      settled: Promise<PluginReplacementOutcome>,
    ): Promise<T> {
      const ids = [...pluginIds];
      // Reservation release/publication is not readiness. The lifecycle owns the
      // final activation/recovery result, including failures after publication.
      const deliver = (result: { ok: true } | { ok: false; error: unknown }) => {
        void settled
          .then((replacement) =>
            this.finish(
              result.ok
                ? { ok: true, pluginIds: ids }
                : {
                    ok: false,
                    pluginIds: ids,
                    error: formatErrorMessage(result.error),
                    replacement,
                  },
              // Unavailable ids describe old rollback code, not the applied generation.
              replacement.kind === "applied" ||
                (!replacement.committed &&
                  replacement.unavailablePluginIds.length === 0 &&
                  (replacement.kind === "restored" || replacement.kind === "unchanged")),
            ),
          )
          .catch((error: unknown) => {
            log.warn(`Plugin maintenance delivery failed: ${formatErrorMessage(error)}`);
          });
      };
      // Config reload releases admission after this returns; never join successors here.
      return reload.then(
        (result) => {
          deliver({ ok: true });
          return result;
        },
        (error: unknown) => {
          deliver({ ok: false, error });
          throw error;
        },
      );
    },
    async finish(outcome: PluginMaintenanceOutcome, healthy: boolean): Promise<void> {
      const captured = [...continuations.values()];
      continuations.clear();
      const settlePluginWork = async (signal: AbortSignal) => {
        await Promise.all(
          drainingInstances.map((instance) =>
            instance.waitForRetainedWork(signal, { includeConsumers: false, includeCalls: true }),
          ),
        );
      };
      await Promise.all(
        captured.map((continuation) => continuation.finish(outcome, healthy, settlePluginWork)),
      );
    },
  };
}
