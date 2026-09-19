import type { DatabaseSync } from "node:sqlite";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { normalizeChannel } from "./conversation-binding-session-key.js";
import type { PluginBindingApprovalEntry } from "./conversation-binding-state.types.js";

type PluginBindingApprovalsDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_binding_approvals">;

export function readPluginBindingApprovalsInDatabase(
  db: DatabaseSync,
): PluginBindingApprovalEntry[] {
  const approvalsDb = getNodeSqliteKysely<PluginBindingApprovalsDatabase>(db);
  const rows = executeSqliteQuerySync(
    db,
    approvalsDb
      .selectFrom("plugin_binding_approvals")
      .select(["plugin_root", "plugin_id", "plugin_name", "channel", "account_id", "approved_at"])
      .orderBy("plugin_root", "asc")
      .orderBy("channel", "asc")
      .orderBy("account_id", "asc"),
  ).rows;
  return rows.map((row) => ({
    pluginRoot: row.plugin_root,
    pluginId: row.plugin_id,
    pluginName: row.plugin_name ?? undefined,
    channel: normalizeChannel(row.channel),
    accountId: normalizeOptionalString(row.account_id) ?? "default",
    approvedAt: row.approved_at,
  }));
}

export function upsertPluginBindingApprovalInDatabase(
  db: DatabaseSync,
  entry: PluginBindingApprovalEntry,
): void {
  const row = {
    plugin_root: entry.pluginRoot,
    channel: normalizeChannel(entry.channel),
    account_id: entry.accountId.trim() || "default",
    plugin_id: entry.pluginId,
    plugin_name: entry.pluginName ?? null,
    approved_at: entry.approvedAt,
  };
  const approvalsDb = getNodeSqliteKysely<PluginBindingApprovalsDatabase>(db);
  executeSqliteQuerySync(
    db,
    approvalsDb
      .insertInto("plugin_binding_approvals")
      .values(row)
      .onConflict((conflict) =>
        conflict.columns(["plugin_root", "channel", "account_id"]).doUpdateSet({
          plugin_id: (eb) => eb.ref("excluded.plugin_id"),
          plugin_name: (eb) => eb.ref("excluded.plugin_name"),
          approved_at: (eb) => eb.ref("excluded.approved_at"),
        }),
      ),
  );
}
