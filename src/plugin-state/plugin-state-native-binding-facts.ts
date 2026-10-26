import { toUSVString } from "node:util";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { parseStoredJson } from "./plugin-state-error.js";
import { readCommittedPluginStateNamespace } from "./plugin-state-namespace-owner.js";
import {
  assertPluginStatePublicationSettled,
  pluginStatePublication,
  pluginStatePublicationKey,
} from "./plugin-state-publication.js";
import type { PluginStateReadRow } from "./plugin-state-store.kernel.js";
import type { capturePluginStateNativeBindingStore } from "./plugin-state-store.native-binding.js";
import { observePluginStateRowInWorker } from "./plugin-state-worker-client.js";

export type PluginStatePinnedEntry = {
  read(): unknown;
  release(): void;
};

/** One held native lease pins its committed row until settlement, independently of the read LRU. */
export async function capturePluginStateNativeBindingFacts(
  store: NonNullable<ReturnType<typeof capturePluginStateNativeBindingStore>>,
  key: string,
  authority = false,
): Promise<PluginStatePinnedEntry> {
  const { options } = store;
  const context = captureOpenClawStateWorkerContext({ env: options.env });
  const identity = () => context.admission.identity.key;
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
    if (change.kind === "unknown" && change.identity === identity()) {
      unavailable = true;
    } else if (change.kind === "committed" && change.receipt.source.identity === identity()) {
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
  const load = async () => {
    if (!active || unavailable) {
      throw new Error("Native binding committed state is unavailable");
    }
    loaded = false;
    row = undefined;
    const observation = await observePluginStateRowInWorker({
      ...scope,
      env: options.env,
      context,
      assertActive: store.assertCurrent,
      sessionEntryCurrent: store.sessionEntryCurrent,
    });
    // A concurrent receipt wins over the read that was already in flight.
    if (!loaded) {
      const observed = readCommittedPluginStateNamespace(identity(), scope);
      row = observed ? observed.get(toUSVString(key)) : observation.row;
      loaded = true;
    }
    if (!active || !loaded || unavailable) {
      throw new Error("Native binding committed state is unavailable");
    }
  };
  try {
    if (authority) {
      assertPluginStatePublicationSettled(identity(), scope);
    }
    const cached = readCommittedPluginStateNamespace(identity(), scope);
    if (cached) {
      row = cached.get(toUSVString(key));
      loaded = true;
    } else {
      await load();
    }
    return {
      read() {
        if (!active || !loaded || unavailable) {
          throw new Error("Native binding committed state is unavailable");
        }
        if (authority) {
          assertPluginStatePublicationSettled(identity(), scope);
          store.assertCurrent?.();
        }
        (context.assertPublicationCurrent ?? context.admission.assertCurrent)();
        return row && (row.expires_at == null || row.expires_at > Date.now())
          ? parseStoredJson(row.value_json, "lookup", context.admission.databasePath)
          : undefined;
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
