import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  buildAcpDatabaseSessionKey,
  selectAcpSessionRow,
} from "../acp/runtime/session-meta-keys.js";
import { selectAcpMigrationRowForStoreEntry } from "../acp/runtime/session-meta-migration-keys.js";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { formatCliCommand } from "../cli/command-format.js";
import { readLegacyAcpMigrationContext } from "../config/sessions/session-accessor.sqlite-acp-provenance.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  readDeferredPluginSessionImport,
  readDeferredPluginSessionImportReceipt,
  readStaleDeferredPluginSessionImport,
  type DeferredPluginSessionImport,
  type SessionImportSource,
} from "./deferred-plugin-session-sources.js";
import { databaseIdentity } from "./deferred-plugin-session-verification.js";
import {
  hasLegacyAcpMigrationCompletion,
  legacyAcpMigrationBindingMatches,
  legacyAcpMigrationSourceKey,
  prepareLegacyAcpMigrationSource,
  recordLegacyAcpMigrationCompletion,
} from "./legacy-acp-migration-source.js";
import type { LegacyMigrationReceipt } from "./state-migrations.receipts.js";

type SessionImportTarget = SessionImportSource["target"] & { sqlitePath: string };

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
      // Declined file metadata stays consumed after the live database gets its own import receipt.
      let imported = coreTarget !== "stale";
      if (coreTarget && coreTarget !== "stale") {
        const { entry: canonical, sources } = readLegacyAcpMigrationContext({
          agentId: params.agentId,
          storePath: coreTarget.sqlitePath,
          sessionKey,
          env: params.env,
        });
        imported =
          legacyAcpMigrationBindingMatches(source, canonical) &&
          !selectAcpMigrationRowForStoreEntry(
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

/** Reuse verified source bytes only within one uninterrupted synchronous migration loop. */
export function prepareDeferredPluginSessionImportReader(
  params: Pick<SessionImportSource, "cfg" | "target" | "env">,
) {
  const verified = new Map<
    string,
    {
      receipt: LegacyMigrationReceipt | null;
      imported: DeferredPluginSessionImport | undefined;
      staleDatabaseIdentity?: string;
    }
  >();
  return (database: DatabaseSync, agentId: string): SessionImportTarget | "stale" | undefined => {
    const sourceTarget = { ...params.target, agentId };
    const sqlite = resolveSqliteTargetFromSessionStorePath(sourceTarget.storePath, {
      agentId,
      env: params.env,
    });
    const target = { ...sourceTarget, sqlitePath: sqlite.path };
    const key = agentId;
    const receipt =
      readDeferredPluginSessionImportReceipt({
        ...params,
        target,
        sqlitePath: target.sqlitePath,
        database,
        includeRemoved: true,
      }) ?? null;
    let prepared = verified.get(key);
    if (!prepared || !isDeepStrictEqual(prepared.receipt, receipt)) {
      const stale = readStaleDeferredPluginSessionImport({
        ...params,
        target,
        sqlitePath: target.sqlitePath,
        database,
      });
      prepared = {
        receipt,
        staleDatabaseIdentity: stale ? databaseIdentity(target.sqlitePath) : undefined,
        imported: stale
          ? undefined
          : readDeferredPluginSessionImport({
              cfg: params.cfg,
              target: sourceTarget,
              sqlitePath: sqlite.path,
              env: params.env,
              database,
              purpose: "canonical",
            }),
      };
      verified.set(key, prepared);
    }
    const expectedIdentity = prepared.staleDatabaseIdentity ?? prepared.imported?.databaseIdentity;
    if (expectedIdentity && expectedIdentity !== databaseIdentity(target.sqlitePath)) {
      throw new Error(
        `The verified session import database changed for ${path.dirname(target.storePath)}; retained source was not replayed. Run ${formatCliCommand("openclaw doctor --session-sqlite recover --session-sqlite-all-agents", params.env)} against the same state/config.`,
      );
    }
    return prepared.staleDatabaseIdentity ? "stale" : prepared.imported ? target : undefined;
  };
}
