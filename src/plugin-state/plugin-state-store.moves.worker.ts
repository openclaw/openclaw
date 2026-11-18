import {
  encodeSqliteStringSet,
  executeSqliteQuerySync,
  sqliteStringSet,
  sqliteStringSetEntries,
} from "../infra/kysely-sync.js";
import { pluginStatePublication } from "./plugin-state-publication.js";
import {
  assertPluginStateKey,
  createPluginStateError,
  getPluginStateKysely,
  isRetainedPluginStateNamespace,
  type PluginStateDatabase,
} from "./plugin-state-store.kernel.js";
import type { PluginStateMoveEntries } from "./plugin-state-store.types.js";

export type PluginStateMoveEntriesParams = {
  pluginId: string;
  namespace: string;
  sourceNamespace: string;
  entries: PluginStateMoveEntries["entries"];
};

/** The worker owns the transaction; no payload decoding or plugin callback occurs here. */
export function movePluginStateEntries(
  store: PluginStateDatabase,
  params: PluginStateMoveEntriesParams,
): number {
  if (
    !isRetainedPluginStateNamespace(params.namespace) ||
    isRetainedPluginStateNamespace(params.sourceNamespace)
  ) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "register",
      message: "Plugin state moves require a bounded source and a retained destination.",
    });
  }
  if (params.entries.length === 0) {
    return 0;
  }
  const now = Date.now();
  const kysely = getPluginStateKysely(store.db);
  for (const entry of params.entries) {
    assertPluginStateKey(store.db, entry.sourceKey, "lookup");
  }
  const sources = new Map(
    executeSqliteQuerySync(
      store.db,
      kysely
        .selectFrom("plugin_state_entries")
        .select(["entry_key", "expires_at"])
        .where("plugin_id", "=", params.pluginId)
        .where("namespace", "=", params.sourceNamespace)
        .where("entry_key", "in", sqliteStringSet(params.entries.map((entry) => entry.sourceKey)))
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)])),
    ).rows.map((row) => [row.entry_key, row.expires_at]),
  );
  const entries = params.entries.filter((entry) => {
    const expiresAt = sources.get(entry.sourceKey);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt !== null) {
      throw createPluginStateError({
        code: "PLUGIN_STATE_INVALID_INPUT",
        operation: "register",
        message: "Cannot move live expiring plugin state into a retained store.",
        path: store.path,
      });
    }
    assertPluginStateKey(store.db, entry.targetKey, "register");
    return true;
  });
  let moved = 0;
  // Bound returned postimages; retained values can be one MiB each.
  for (let offset = 0; offset < entries.length; offset += 64) {
    const batch = entries.slice(offset, offset + 64);
    const keys = batch.map((entry) => entry.sourceKey);
    const inserted = executeSqliteQuerySync(
      store.db,
      kysely
        .insertInto("plugin_state_entries")
        .columns(["plugin_id", "namespace", "entry_key", "value_json", "created_at", "expires_at"])
        .expression(
          kysely
            .selectFrom(sqliteStringSetEntries(encodeSqliteStringSet(keys)).as("requested"))
            .innerJoin(
              sqliteStringSetEntries(
                encodeSqliteStringSet(batch.map((entry) => entry.targetKey)),
              ).as("target"),
              "target.key",
              "requested.key",
            )
            .crossJoin("plugin_state_entries")
            .where("plugin_id", "=", params.pluginId)
            .where("namespace", "=", params.sourceNamespace)
            .whereRef("entry_key", "=", "requested.value")
            .select((eb) => [
              "plugin_id",
              eb.val(params.namespace).as("namespace"),
              eb.ref("target.value").$notNull().as("entry_key"),
              "value_json",
              "created_at",
              "expires_at",
            ]),
        )
        .onConflict((conflict) =>
          conflict
            .columns(["plugin_id", "namespace", "entry_key"])
            .doUpdateSet({
              value_json: (eb) => eb.ref("excluded.value_json"),
              created_at: (eb) => eb.ref("excluded.created_at"),
              expires_at: (eb) => eb.ref("excluded.expires_at"),
            })
            .where("plugin_state_entries.expires_at", "<=", now),
        )
        .returningAll(),
    );
    for (const row of inserted.rows) {
      pluginStatePublication.stagePostimage(store.db, row);
    }
    const deleted = executeSqliteQuerySync(
      store.db,
      kysely
        .deleteFrom("plugin_state_entries")
        .where("plugin_id", "=", params.pluginId)
        .where("namespace", "=", params.sourceNamespace)
        .where("entry_key", "in", sqliteStringSet(keys))
        .returning(["plugin_id", "namespace", "entry_key"]),
    );
    pluginStatePublication.stageDeletions(store.db, deleted.rows);
    moved += deleted.rows.length;
  }
  return moved;
}
