import { createDeferredCore } from "../shared/deferred.js";
import { announcePluginReplacement } from "./plugin-replacement-watchers.js";

/** Host-only operation result, distinct from reservation release and operator status. */
export type PluginReplacementOutcome = Readonly<{
  kind: "applied" | "restored" | "unchanged" | "failed";
  committed: boolean;
  unavailablePluginIds: readonly string[];
}>;
export type PluginReplacementOperation = Readonly<{
  operationId: string;
  settled: Promise<PluginReplacementOutcome>;
}>;
const replacementOperations = new WeakMap<object, PluginReplacementOperation>();

/** Exact private reservation identity; never exposed through plugin values or JSON. */
export function readPluginReplacementOperation(instance: object) {
  return replacementOperations.get(instance);
}

/** The instance's reservation owns both publication and its matching release. */
export function createPluginReplacementReservation(instance: {
  readonly pluginId: string;
  readonly hasActiveCall: boolean;
}) {
  let settlement: ReturnType<typeof createDeferredCore<void>> | undefined;
  return {
    get settled() {
      return settlement?.promise;
    },
    reserveReplacement(this: void, operation?: PluginReplacementOperation): () => void {
      if (instance.hasActiveCall) {
        throw new Error(
          "Plugin " +
            instance.pluginId +
            " cannot replace itself from its own active call; retry after the call finishes.",
        );
      }
      // Any release ends this reservation and settles callers waiting on it.
      const alreadyPending = settlement !== undefined;
      const settled = (settlement ??= createDeferredCore());
      if (!alreadyPending && operation) {
        replacementOperations.set(instance, operation);
      }
      // Publish the exact operation before notifying any holder.
      announcePluginReplacement(instance, alreadyPending);
      return () => {
        if (settlement === settled) {
          settlement = undefined;
          replacementOperations.delete(instance);
          settled.resolve();
        }
      };
    },
  };
}
