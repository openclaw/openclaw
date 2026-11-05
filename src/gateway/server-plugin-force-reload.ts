import { setTimeout as delay } from "node:timers/promises";
import type {
  CapturedPluginMaintenanceContinuation,
  PluginMaintenanceOutcome,
  capturePluginMaintenanceContinuation,
} from "../agents/plugin-maintenance-continuation.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import type { PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";

const log = createSubsystemLogger("gateway/plugin-maintenance");

/** One reload's bounded, in-memory handoff; reservation and physical leases stay plugin-owned. */
export function createPluginForceReload(capture: typeof capturePluginMaintenanceContinuation) {
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
        // Reservation rejects fresh acquisition. Reconcile once for work already admitted
        // before it; later unbound holders retain the ordinary bounded drain behavior.
        for (let pass = 0; pass < 2; pass++) {
          for (const owner of ownersOf(instances)) {
            if (continuations.has(owner)) {
              continue;
            }
            signal.throwIfAborted();
            const preparation = capture(owner);
            if (!preparation) {
              throw new Error(
                "Cannot force reload: selected plugin work has no supported native conversation continuation. Wait for that work to finish, then retry.",
              );
            }
            continuations.set(owner, await preparation);
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
          [...continuations.values()].map((continuation) => continuation.interrupt()),
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
    complete<T>(reload: Promise<T>, pluginIds: string[]): Promise<T> {
      // Config reload releases admission only after this returns. Captured effects
      // own delivery; joining their successor here waits on this very reload.
      return reload.then(
        (result) => {
          void this.finish({ ok: true, pluginIds }, true).catch((error: unknown) => {
            log.warn(`Plugin maintenance delivery failed: ${formatErrorMessage(error)}`);
          });
          return result;
        },
        (error: unknown) => {
          void this.finish(
            { ok: false, pluginIds, error: formatErrorMessage(error) },
            error instanceof PluginRuntimeApplicationError &&
              !error.details.runtimeRestorationFailed,
          ).catch((deliveryError: unknown) => {
            log.warn(`Plugin maintenance delivery failed: ${formatErrorMessage(deliveryError)}`);
          });
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
