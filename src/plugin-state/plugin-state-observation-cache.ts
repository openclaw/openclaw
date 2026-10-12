import { LruCache } from "../infra/lru-cache.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  createPluginStateObservation,
  pluginStateComparisonScope,
} from "./plugin-state-observation.js";
import { pluginStatePublication } from "./plugin-state-publication.js";
import type { PluginStateReadRow } from "./plugin-state-store.kernel.js";
import type { PluginStateEntry } from "./plugin-state-store.types.js";

type Key = { pluginId: string; namespace: string; key: string };
type Entry = { identity: string; loaded: boolean; row?: PluginStateReadRow };
type NamespaceEntry = {
  identity: string;
  keyPrefix: string;
  entries?: PluginStateEntry<unknown>[];
  bytes: number;
};

const state = resolveGlobalSingleton(Symbol.for("openclaw.pluginStateObservationCache"), () => {
  const entries = new LruCache<Entry>(512, {
    maxBytes: 8 * 1024 * 1024,
    sizeOf: (entry) => 128 + (entry.row?.value_json.length ?? 0) * 2,
  });
  const namespaces = new LruCache<NamespaceEntry>(64, {
    maxBytes: 8 * 1024 * 1024,
    sizeOf: (entry) => entry.bytes,
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
      for (const [key, fact] of change.receipt.facts) {
        const entryKey = JSON.stringify([identity, key]);
        if (fact.kind === "unknown") {
          entries.delete(entryKey);
        } else {
          entries.set(entryKey, {
            identity,
            loaded: true,
            row: fact.kind === "postimage" ? fact.value : undefined,
          });
        }
      }
    }
    if (change.kind === "unknown" || change.kind === "committed") {
      for (const key of namespaces.keys()) {
        const entry = namespaces.peek(key)!;
        if (
          entry.identity === identity &&
          (change.kind === "unknown" ||
            [...change.receipt.facts.keys()].some((factKey) => factKey.startsWith(entry.keyPrefix)))
        ) {
          namespaces.delete(key);
        }
      }
    }
  });
  return { entries, namespaces, pending };
});

function cacheKey(identity: string, key: Key): string {
  return JSON.stringify([identity, JSON.stringify([key.pluginId, key.namespace, key.key])]);
}

export function readPluginStateObservationCache(identity: string, key: Key) {
  if (state.pending.has(identity)) {
    return undefined;
  }
  return readCommittedPluginStateObservationCache(identity, key);
}

/** Pending writes do not replace committed facts used by a live native lease. */
export function readCommittedPluginStateObservationCache(identity: string, key: Key) {
  const entry = state.entries.get(cacheKey(identity, key));
  if (!entry?.loaded) {
    return undefined;
  }
  const row = entry.row;
  return { row: row?.expires_at != null && row.expires_at <= Date.now() ? undefined : row };
}

export function preparePluginStateObservationCacheRead(identity: string, key: Key) {
  const id = cacheKey(identity, key);
  const entry: Entry = { identity, loaded: false };
  state.entries.set(id, entry);
  return (row: PluginStateReadRow | undefined) => {
    // A commit or unknown settlement while the read was in flight wins over its reply.
    if (state.entries.peek(id) === entry) {
      state.entries.set(id, { identity, loaded: true, row });
    }
  };
}

export function readPluginStateEntriesCache(identity: string, key: Omit<Key, "key">) {
  if (state.pending.has(identity)) {
    return undefined;
  }
  const entries = state.namespaces.get(
    JSON.stringify([identity, key.pluginId, key.namespace]),
  )?.entries;
  if (!entries) {
    return undefined;
  }
  const now = Date.now();
  return structuredClone(
    entries.filter((entry) => entry.expiresAt == null || entry.expiresAt > now),
  );
}

export function preparePluginStateEntriesCacheRead(identity: string, key: Omit<Key, "key">) {
  const id = JSON.stringify([identity, key.pluginId, key.namespace]);
  const entry: NamespaceEntry = {
    identity,
    keyPrefix: `${JSON.stringify([key.pluginId, key.namespace]).slice(0, -1)},`,
    bytes: 128,
  };
  state.namespaces.set(id, entry);
  return (entries: PluginStateEntry<unknown>[]) => {
    // A namespace receipt supersedes the whole list, including an acknowledged empty list.
    if (state.namespaces.peek(id) === entry) {
      state.namespaces.set(id, {
        ...entry,
        entries: structuredClone(entries),
        bytes: 128 + JSON.stringify(entries).length * 2,
      });
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
