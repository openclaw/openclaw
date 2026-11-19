import { withPluginHostCleanupTimeout } from "../plugins/host-hook-cleanup-timeout.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { DecisionProviderHost } from "./provider-host.js";

/** Abort before dependent consumers drain. Services subsequently join actual physical settlement. */
export function prepareDecisionProviderReload(
  registry: PluginRegistry,
  changedPluginIds: ReadonlySet<string>,
) {
  const paused: ReturnType<DecisionProviderHost["pauseForReload"]>[] = [];
  for (const entry of registry.decisionProviders) {
    if (changedPluginIds.has(entry.pluginId)) {
      paused.push(entry.host.pauseForReload(changedPluginIds));
    } else {
      for (const pluginId of changedPluginIds) {
        entry.host.cancelConsumer(pluginId);
      }
    }
  }
  return {
    async rollback(signal: AbortSignal) {
      // Timeout only observes settlement: no detached continuation may reopen admission.
      await withPluginHostCleanupTimeout("decision reload rollback", () =>
        Promise.all(paused.map((pause) => pause.settled)),
      );
      signal.throwIfAborted();
      for (const pause of paused) {
        pause.assertResumable();
      }
      for (const pause of paused) {
        pause.resume();
      }
    },
  };
}
