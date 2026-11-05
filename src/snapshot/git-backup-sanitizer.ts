import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stripPluginModelCatalogCredentials } from "../agents/plugin-model-catalog-repair.js";
import type { PortRow } from "../infra/database-engine/port-descriptor.js";
import {
  AGENT_SECRET_TABLE_NAMES,
  STATE_SECRET_CONFIG_STATE_KEY_PREFIXES,
  STATE_SECRET_PLUGIN_SCOPES,
  STATE_SECRET_TABLE_NAMES,
} from "../state/secret-state-tables.js";
import type { SnapshotDatabaseIdentity } from "./snapshot-provider.js";

type RedactionIdentity = Pick<SnapshotDatabaseIdentity, "role">;
const modelCatalogScopes = ["plugin-model-catalog-v1", "plugin-model-catalog-migration-v1"];

function resolveRedactionIdentity(
  identity: RedactionIdentity,
  postgresFamily?: string,
): RedactionIdentity {
  // A retained store's Git scope need not be its database family (for example Matrix state).
  return {
    role:
      postgresFamily === "state" ? "global" : postgresFamily === "agent" ? "agent" : identity.role,
  };
}

export function gitBackupRedaction(
  identity: RedactionIdentity,
  tables: ReadonlySet<string>,
  excludeSecrets: boolean,
  postgresFamily?: string,
) {
  const owner = resolveRedactionIdentity(identity, postgresFamily);
  const secretTables =
    owner.role === "global" ? STATE_SECRET_TABLE_NAMES : AGENT_SECRET_TABLE_NAMES;
  return {
    excludedTables: excludeSecrets
      ? secretTables.filter((table) => tables.has(table)).toSorted()
      : [],
    excludedConfigStateKeyPrefixes:
      excludeSecrets && owner.role === "global" && tables.has("config_machine_state")
        ? [...STATE_SECRET_CONFIG_STATE_KEY_PREFIXES]
        : [],
  };
}

/** Shared by serialized SQLite rows and the portable PostgreSQL image. */
export function redactGitBackupRow(
  table: string,
  row: Record<string, unknown>,
  identity: RedactionIdentity,
  prefixes: readonly string[],
): boolean {
  if (table === "plugin_state_entries" || table === "plugin_blob_entries") {
    if (typeof row.namespace !== "string") {
      return false;
    }
    // Retained keyed stores use the same table with a physical namespace prefix.
    const namespace = row.namespace.replace(/^@retained\./u, "");
    const scope = STATE_SECRET_PLUGIN_SCOPES.find(
      (candidate) =>
        candidate.pluginId === row.plugin_id &&
        candidate.namespace.test(namespace) &&
        (candidate.entryKey === undefined || candidate.entryKey === row.entry_key),
    );
    if (!scope) {
      return true;
    }
    if (!scope.jsonFields || table === "plugin_blob_entries") {
      return false;
    }
    row.value_json = redactPluginJsonFields(row.value_json, scope.jsonFields);
    return row.value_json !== null;
  }
  if (table === "config_machine_state" && prefixes.length > 0) {
    const stateKey = row.state_key;
    // Malformed keys cannot establish that the row is outside the secret scopes.
    if (typeof stateKey !== "string" || prefixes.some((prefix) => stateKey.startsWith(prefix))) {
      return false;
    }
  }
  if (
    identity.role === "agent" &&
    table === "cache_entries" &&
    modelCatalogScopes.some((scope) => row.scope === scope) &&
    typeof row.value_json === "string"
  ) {
    row.value_json = stripPluginModelCatalogCredentials(row.value_json);
    return row.value_json !== null;
  }
  return true;
}

function redactPluginJsonFields(value: unknown, fields: readonly string[]): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return null;
    }
    for (const field of fields) {
      delete parsed[field];
    }
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

/** Redact before materialization so credential bytes never enter the portable image. */
export function createGitBackupRowTransform(
  identity: RedactionIdentity,
  postgresFamily: string,
  tables: ReadonlySet<string>,
): (table: string, row: PortRow) => PortRow | undefined {
  const owner = resolveRedactionIdentity(identity, postgresFamily);
  const redaction = gitBackupRedaction(owner, tables, true);
  const excludedTables = new Set<string>(redaction.excludedTables);
  return (table, row) => {
    if (
      excludedTables.has(table) ||
      !redactGitBackupRow(table, row, owner, redaction.excludedConfigStateKeyPrefixes)
    ) {
      return undefined;
    }
    return row;
  };
}
