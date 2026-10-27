import { toUSVString } from "node:util";
import { LruCache } from "../infra/lru-cache.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "../state/openclaw-state-db-cache.js";
import {
  hasPendingPluginStatePublication,
  pluginStatePublication,
} from "./plugin-state-publication.js";
import {
  PLUGIN_STATE_NAMESPACE_MAX_BYTES,
  PLUGIN_STATE_NAMESPACE_MAX_ROWS,
  pluginStateNamespaceRowBytes,
  rowToEntry,
  type PluginStateReadRow,
} from "./plugin-state-store.kernel.js";
import type { PluginStateKeyRangeParams } from "./plugin-state-store.types.js";

type Scope = { pluginId: string; namespace: string };
type View = {
  identity: string;
  keyPrefix: string;
  rows?: Map<string, PluginStateReadRow>;
  loading?: Promise<void>;
  bytes: number;
};
export const PLUGIN_STATE_RESIDENT_NAMESPACES = 64;

/**
 * The DB-wide owner lease admits one live writer. Offline writers run with the Gateway
 * stopped, and close/reopen retires views. Cross-host sharing of one store is unsupported.
 */
const views = resolveGlobalSingleton(Symbol.for("openclaw.pluginStateNamespaceOwner"), () => {
  const entries = new LruCache<View>(PLUGIN_STATE_RESIDENT_NAMESPACES, {
    maxBytes: 16 * 1024 * 1024,
    sizeOf: (view) => view.bytes,
  });
  const retire = (identity?: string) => {
    for (const key of entries.keys()) {
      if (identity === undefined || entries.peek(key)?.identity === identity) {
        entries.delete(key);
      }
    }
  };
  registerOpenClawStateDatabaseLifecycleListener((event) => {
    if (event.kind !== "opened" && event.identity) {
      retire(event.identity.key);
    }
  });
  registerOpenClawStateDatabaseAsyncResource({
    close(identity) {
      retire(identity?.key);
      return Promise.resolve();
    },
  });
  pluginStatePublication.subscribeFacts((change) => {
    if (change.kind !== "unknown" && change.kind !== "committed") {
      return;
    }
    const identity = change.kind === "unknown" ? change.identity : change.receipt.source.identity;
    // Snapshot keys so reinserted views are visited only once.
    const namespaceIds = [...entries.keys()];
    for (const id of namespaceIds) {
      const view = entries.peek(id);
      if (!view || view.identity !== identity) {
        continue;
      }
      if (change.kind === "unknown") {
        entries.delete(id);
        continue;
      }
      const facts = [...change.receipt.facts].filter(([key]) => key.startsWith(view.keyPrefix));
      if (facts.length === 0) {
        continue;
      }
      entries.delete(id);
      // A partial postimage cannot establish completeness or salvage a load overtaken by a write.
      if (!view.rows || facts.some(([, fact]) => fact.kind === "unknown")) {
        continue;
      }
      for (const [key, fact] of facts) {
        const entryKey: string = JSON.parse(key)[2];
        const previous = view.rows.get(entryKey);
        view.bytes -= previous ? pluginStateNamespaceRowBytes(previous) : 0;
        if (fact.kind === "postimage") {
          view.rows.set(entryKey, fact.value);
          view.bytes += pluginStateNamespaceRowBytes(fact.value);
        } else {
          view.rows.delete(entryKey);
        }
      }
      if (
        view.bytes <= PLUGIN_STATE_NAMESPACE_MAX_BYTES &&
        view.rows.size <= PLUGIN_STATE_NAMESPACE_MAX_ROWS
      ) {
        entries.set(id, view);
      }
    }
  });
  return entries;
});

function namespaceId(identity: string, scope: Scope): string {
  return JSON.stringify([identity, scope.pluginId, scope.namespace]);
}

/** A live native lease may consume committed facts while its own write is pending. */
export function readCommittedPluginStateNamespace(
  identity: string,
  scope: Scope,
): ReadonlyMap<string, PluginStateReadRow> | undefined {
  return views.get(namespaceId(identity, scope))?.rows;
}

export function readPluginStateNamespace(identity: string, scope: Scope) {
  return hasPendingPluginStatePublication(identity, scope)
    ? undefined
    : readCommittedPluginStateNamespace(identity, scope);
}

/** Cold reads join one bounded load. An intervening fact retires its placeholder, never retries. */
export function ensurePluginStateNamespace(
  identity: string,
  scope: Scope,
  load: (maxBytes: number) => Promise<readonly PluginStateReadRow[] | undefined>,
): Promise<void> | undefined {
  const id = namespaceId(identity, scope);
  const current = views.get(id);
  if (current) {
    return current.loading;
  }
  const view: View = {
    identity,
    keyPrefix: `${JSON.stringify([scope.pluginId, scope.namespace]).slice(0, -1)},`,
    bytes: 128 + 2 * id.length,
  };
  views.set(id, view);
  view.loading = load(PLUGIN_STATE_NAMESPACE_MAX_BYTES - view.bytes).then(
    (rows) => {
      if (views.peek(id) !== view) {
        return;
      }
      views.delete(id);
      if (rows) {
        view.rows = new Map(rows.map((row) => [row.entry_key, row]));
        view.bytes += rows.reduce((bytes, row) => bytes + pluginStateNamespaceRowBytes(row), 0);
      }
      view.loading = undefined;
      views.set(id, view);
    },
    (error: unknown) => {
      if (views.peek(id) === view) {
        views.delete(id);
      }
      throw error;
    },
  );
  return view.loading;
}

export function livePluginStateRow(row: PluginStateReadRow | undefined, now = Date.now()) {
  return row?.expires_at != null && row.expires_at <= now ? undefined : row;
}

export function listResidentPluginStateEntries(
  rows: ReadonlyMap<string, PluginStateReadRow>,
  path: string,
  range?: PluginStateKeyRangeParams,
) {
  const now = Date.now();
  let selected = [...rows.values()].filter((row) => livePluginStateRow(row, now));
  const compareKeys = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  if (range) {
    selected = selected.filter(
      (row) =>
        compareKeys(row.entry_key, toUSVString(range.keyStartInclusive)) >= 0 &&
        compareKeys(row.entry_key, toUSVString(range.keyEndExclusive)) < 0,
    );
    selected.sort(
      (a, b) => compareKeys(a.entry_key, b.entry_key) * (range.order === "desc" ? -1 : 1),
    );
    selected = selected.slice(0, range.limit);
  } else {
    selected.sort((a, b) => a.created_at - b.created_at || compareKeys(a.entry_key, b.entry_key));
  }
  return selected.map((row) => rowToEntry(row, "entries", path));
}
