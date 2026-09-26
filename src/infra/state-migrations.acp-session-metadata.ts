import {
  buildAcpDatabaseSessionKey,
  selectAcpSessionRow,
  selectAcpSessionRowForStoreEntry,
} from "../acp/runtime/session-meta-keys.js";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { readLegacyAcpMigrationContext } from "../config/sessions/session-accessor.sqlite-acp-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { prepareDeferredPluginSessionImportReader } from "./deferred-plugin-session-sources.js";
import {
  hasLegacyAcpMigrationCompletion,
  legacyAcpMigrationBindingMatches,
  legacyAcpMigrationSourceKey,
  prepareLegacyAcpMigrationSource,
  recordLegacyAcpMigrationCompletion,
} from "./legacy-acp-migration-source.js";

type LegacyAcpMetadataInput = Omit<
  Parameters<typeof writeAcpSessionMetaForMigration>[0],
  "database" | "databasePath"
> & {
  sourcePath: string;
  sourceSessionKey: string;
  preserveSource: boolean;
  cfg: OpenClawConfig;
  agentId: string;
  readVerifiedCoreImport: ReturnType<typeof prepareDeferredPluginSessionImportReader>;
};

/** Retained JSON is input history, not authority to reopen a completed ACP import. */
export function importLegacyAcpSessionMetadata(params: LegacyAcpMetadataInput): boolean {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return false;
  }
  const databaseKey = buildAcpDatabaseSessionKey(sessionKey, params.agentId);
  const source = prepareLegacyAcpMigrationSource(params);
  const now = params.now?.() ?? Date.now();
  return runOpenClawStateWriteTransaction(
    (database) => {
      if (hasLegacyAcpMigrationCompletion(database.db, source)) {
        return false;
      }
      const coreTarget = params.readVerifiedCoreImport(database.db, params.agentId);
      let imported = true;
      if (coreTarget) {
        const { entry: canonical, sources } = readLegacyAcpMigrationContext({
          agentId: params.agentId,
          storePath: coreTarget.sqlitePath,
          sessionKey,
          env: params.env,
        });
        imported =
          legacyAcpMigrationBindingMatches(source, canonical) &&
          !selectAcpSessionRowForStoreEntry(
            database.db,
            sessionKey,
            params.agentId,
            params.cfg,
            canonical,
          );
        if (
          imported &&
          !sources.some(
            (recorded) =>
              legacyAcpMigrationSourceKey(recorded) === legacyAcpMigrationSourceKey(source) &&
              recorded.sourceSha256 === source.sourceSha256,
          )
        ) {
          throw new Error(
            "Retained ACP import has no matching recorded source provenance; metadata was not replayed.",
          );
        }
      }
      const current = imported ? selectAcpSessionRow(database.db, databaseKey) : undefined;
      if (current) {
        // Without a verified superseding session, only the same lifecycle binding
        // can consume this source. Conflicts must retain both owners' metadata.
        const sourceBinding = source.lifecycleRevision ?? source.sessionId;
        if (!sourceBinding || current.session_id !== sourceBinding) {
          throw new Error(
            "Canonical ACP metadata has a conflicting session binding; resolve the conflict before rerunning Doctor. Legacy metadata was retained.",
          );
        }
        imported = false;
      }
      if (imported) {
        writeAcpSessionMetaForMigration({
          ...params,
          sessionKey: databaseKey,
          database,
          now: () => now,
        });
      }
      if (params.preserveSource) {
        recordLegacyAcpMigrationCompletion(database.db, source, now);
      }
      return imported;
    },
    { env: params.env },
    { operationLabel: "state.import-legacy-acp-metadata" },
  );
}
