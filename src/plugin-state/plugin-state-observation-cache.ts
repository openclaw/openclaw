import { LruCache } from "../infra/lru-cache.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  createPluginStateObservation,
  pluginStateComparisonScope,
} from "./plugin-state-observation.js";
import { pluginStatePublication } from "./plugin-state-publication.js";
import type { PluginStateReadRow } from "./plugin-state-store.kernel.js";

type Key = { pluginId: string; namespace: string; key: string };
type Entry = {
  identity: string;
  loaded: boolean;
  row?: PluginStateReadRow;
  writeRevision?: number;
};

const state = resolveGlobalSingleton(Symbol.for("openclaw.pluginStateObservationCache"), () => {
  const entries = new LruCache<Entry>(512, {
    maxBytes: 8 * 1024 * 1024,
    sizeOf: (entry) => 128 + (entry.row?.value_json.length ?? 0) * 2,
  });
  const pending = new Map<string, Set<string>>();
  pluginStatePublication.subscribeFacts((change) => {
    const identity = change.kind === "committed" ? change.receipt.source.identity : change.identity;
    if (typeof identity !== "string") {
      return;
    }
    if (change.kind === "pending") {
      const operations = pending.get(identity) ?? new Set<string>();
      operations.add(change.operationId);
      pending.set(identity, operations);
    } else if (change.kind === "settled") {
      const operations = pending.get(identity);
      operations?.delete(change.operationId);
      if (!operations?.size) {
        pending.delete(identity);
      }
    } else if (change.kind === "unknown") {
      for (const key of entries.keys()) {
        if (entries.peek(key)?.identity === identity) {
          entries.delete(key);
        }
      }
    } else if (change.kind === "committed") {
      const writeRevision = change.receipt.writeRevision;
      for (const [key, fact] of change.receipt.facts) {
        const entryKey = JSON.stringify([identity, key]);
        if (fact.kind === "unknown") {
          entries.delete(entryKey);
        } else {
          entries.set(entryKey, {
            identity,
            loaded: true,
            row: fact.kind === "postimage" ? fact.value : undefined,
            writeRevision,
          });
        }
      }
    }
  });
  return { entries, pending };
});

function cacheKey(identity: string, key: Key): string {
  return JSON.stringify([identity, JSON.stringify([key.pluginId, key.namespace, key.key])]);
}

export function readPluginStateObservationCache(
  identity: string,
  key: Key,
  writeRevision: number | undefined,
) {
  if (state.pending.has(identity)) {
    return undefined;
  }
  const entry = state.entries.get(cacheKey(identity, key));
  if (!entry?.loaded || writeRevision === undefined || entry.writeRevision !== writeRevision) {
    return undefined;
  }
  const row = entry.row;
  return { row: row?.expires_at != null && row.expires_at <= Date.now() ? undefined : row };
}

export function preparePluginStateObservationCacheRead(
  identity: string,
  key: Key,
  writeRevision: number | undefined,
) {
  const id = cacheKey(identity, key);
  const entry: Entry = { identity, loaded: false };
  state.entries.set(id, entry);
  return (row: PluginStateReadRow | undefined) => {
    // A commit or unknown settlement while the read was in flight wins over its reply.
    if (state.entries.peek(id) === entry) {
      state.entries.set(id, { identity, loaded: true, row, writeRevision });
    }
  };
}

export function observationFromCachedPluginState(
  identity: string,
  path: string,
  key: Key,
  current: { row?: PluginStateReadRow },
) {
  return createPluginStateObservation(
    path,
    pluginStateComparisonScope(identity, key),
    current.row,
    "lookup",
  );
}
