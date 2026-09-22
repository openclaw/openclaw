import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  legacyAcpMigrationBindingMatches,
  legacyAcpMigrationSourceKey,
  legacyAcpMigrationSourceSchema,
  type LegacyAcpMigrationSource,
} from "../../infra/legacy-acp-migration-source.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  ensureLegacyAcpMigrationProvenanceColumn,
  hasLegacyAcpMigrationProvenanceColumn,
} from "../../state/openclaw-agent-legacy-acp-schema.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-read.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import type { SessionEntry } from "./types.js";

const sourcesSchema = z.array(legacyAcpMigrationSourceSchema);

function readSources(database: DatabaseSync, sessionKey: string): LegacyAcpMigrationSource[] {
  if (!hasLegacyAcpMigrationProvenanceColumn(database)) {
    return [];
  }
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getSessionKysely(database)
      .selectFrom("session_nodes")
      .select("legacy_acp_migration_json")
      .where("session_key", "=", sessionKey),
  );
  return row?.legacy_acp_migration_json
    ? sourcesSchema.parse(JSON.parse(row.legacy_acp_migration_json))
    : [];
}

export function readLegacyAcpMigrationContext(scope: SessionEntryReadScope) {
  const resolved = resolveSqliteScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const selected = readExactSessionEntryRowValidated(database, resolved.sessionKey);
    return {
      entry: selected?.entry,
      sources: selected?.row.legacy_acp_migration_json
        ? sourcesSchema.parse(JSON.parse(selected.row.legacy_acp_migration_json))
        : [],
    };
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : { entry: undefined, sources: [] };
}

function writeSources(
  database: DatabaseSync,
  sessionKey: string,
  sources: LegacyAcpMigrationSource[],
): void {
  ensureLegacyAcpMigrationProvenanceColumn(database);
  executeSqliteQuerySync(
    database,
    getSessionKysely(database)
      .updateTable("session_nodes")
      .set({ legacy_acp_migration_json: sources.length ? JSON.stringify(sources) : null })
      .where("session_key", "=", sessionKey),
  );
}

/** Repair retries may carry the same source again, but cannot restamp its consumed identity. */
export function recordLegacyAcpMigrationSources(
  database: DatabaseSync,
  sessionKey: string,
  sources: readonly LegacyAcpMigrationSource[],
): void {
  if (!sources.length) {
    return;
  }
  const merged = new Map(
    readSources(database, sessionKey).map((source) => [
      legacyAcpMigrationSourceKey(source),
      source,
    ]),
  );
  for (const source of sources) {
    const key = legacyAcpMigrationSourceKey(source);
    const existing = merged.get(key);
    if (existing && existing.sourceSha256 !== source.sourceSha256) {
      throw new Error("Retained ACP source provenance changed during session import.");
    }
    if (!existing) {
      merged.set(key, source);
    }
  }
  writeSources(database, sessionKey, [...merged.values()]);
}

export function retainLegacyAcpMigrationSourcesForEntry(
  database: DatabaseSync,
  sessionKey: string,
  entry: SessionEntry | undefined,
): void {
  const sources = readSources(database, sessionKey);
  const retained = sources.filter((source) => legacyAcpMigrationBindingMatches(source, entry));
  if (retained.length !== sources.length) {
    writeSources(database, sessionKey, retained);
  }
}

export function copyLegacyAcpMigrationSourcesForRepair(
  source: Pick<OpenClawAgentDatabase, "db">,
  destination: OpenClawAgentDatabase,
  sourceKeys: readonly string[],
  canonicalKey: string,
): void {
  recordLegacyAcpMigrationSources(
    destination.db,
    canonicalKey,
    sourceKeys.flatMap((key) => readSources(source.db, key)),
  );
}
