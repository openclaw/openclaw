import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { parseStoredJson } from "./plugin-state-error.js";
import { readCommittedPluginStateObservationCache } from "./plugin-state-observation-cache.js";
import { pluginStatePublication, pluginStatePublicationKey } from "./plugin-state-publication.js";
import type { PluginStateReadRow } from "./plugin-state-store.kernel.js";
import type { capturePluginStateNativeBindingStore } from "./plugin-state-store.native-binding.js";
import { observePluginStateInWorker } from "./plugin-state-worker-client.js";

export type PluginStatePinnedEntry = {
  read(): unknown;
  refresh(): Promise<void>;
  release(): void;
};

/** One held native lease pins its committed row until settlement, independently of the read LRU. */
export async function capturePluginStateNativeBindingFacts(
  store: NonNullable<ReturnType<typeof capturePluginStateNativeBindingStore>>,
  key: string,
): Promise<PluginStatePinnedEntry> {
  const { options } = store;
  const context = captureOpenClawStateWorkerContext({ env: options.env });
  const identity = context.admission.identity.key;
  const scope = { pluginId: options.pluginId, namespace: options.namespace, key };
  const entryKey = pluginStatePublicationKey({
    plugin_id: scope.pluginId,
    namespace: scope.namespace,
    entry_key: key,
  });
  let active = true;
  let loaded = false;
  let row: PluginStateReadRow | undefined;
  let unavailable = false;
  const stop = pluginStatePublication.subscribeFacts((change) => {
    if (change.kind === "unknown" && change.identity === identity) {
      unavailable = true;
    } else if (change.kind === "committed" && change.receipt.source.identity === identity) {
      const fact = change.receipt.facts.get(entryKey);
      if (fact?.kind === "unknown") {
        unavailable = true;
      } else if (fact) {
        row = fact.kind === "postimage" ? fact.value : undefined;
        loaded = true;
      }
    }
  });
  const release = () => {
    active = false;
    row = undefined;
    stop();
  };
  const refresh = async () => {
    if (!active) {
      throw new Error("Native binding committed state is unavailable");
    }
    loaded = false;
    unavailable = false;
    row = undefined;
    await observePluginStateInWorker({
      ...scope,
      env: options.env,
      context,
      assertActive: store.assertCurrent,
      sessionEntryCurrent: store.sessionEntryCurrent,
    });
    // A concurrent receipt wins over the read that was already in flight.
    if (!loaded) {
      const observed = readCommittedPluginStateObservationCache(identity, scope);
      if (observed) {
        row = observed.row;
        loaded = true;
      }
    }
    if (!active || !loaded || unavailable) {
      throw new Error("Native binding committed state is unavailable");
    }
  };
  try {
    const cached = readCommittedPluginStateObservationCache(identity, scope);
    if (cached) {
      row = cached.row;
      loaded = true;
    } else {
      await refresh();
    }
    return {
      read() {
        if (!active || !loaded || unavailable) {
          throw new Error("Native binding committed state is unavailable");
        }
        (context.assertPublicationCurrent ?? context.admission.assertCurrent)();
        return row && (row.expires_at == null || row.expires_at > Date.now())
          ? parseStoredJson(row.value_json, "lookup", context.admission.databasePath)
          : undefined;
      },
      refresh,
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
