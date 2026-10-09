import { existsSync, realpathSync } from "node:fs";
import nodePath from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import type { SqliteSchemaIssue } from "../infra/sqlite-schema-contract.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import { configureSqliteReadOnlyPragmas } from "../infra/sqlite-wal.js";
import { describeDeferredStateSchemaPublication } from "./openclaw-database-preflight.messages.js";
import type {
  DeferredStateSchemaPublication,
  OpenClawStateSchemaPreflightResult,
} from "./openclaw-database-preflight.types.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";
import { assertNoLegacyStateRuntimeRepair } from "./openclaw-state-db-fast-path.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import {
  inspectOpenClawStateOwnershipFromDatabase,
  type OpenClawExternalStateOwnership,
} from "./openclaw-state-ownership.js";
import { inspectCurrentStateStartupSchema } from "./openclaw-state-schema-inspection.js";
import { readStateSchemaPublicationBlocker } from "./openclaw-state-schema-publication.js";

/** Compare one explicit SQLite file with this release's canonical shared-state schema. */
export async function preflightOpenClawStateDatabasePath(
  databasePath: string,
): Promise<OpenClawStateSchemaPreflightResult> {
  const resolvedPath = nodePath.resolve(databasePath);
  const base = {
    schema: "openclaw.state-schema-preflight.v1",
    databasePath: resolvedPath,
    targetVersion: OPENCLAW_STATE_SCHEMA_VERSION,
  } as const;
  let database: DatabaseSync | undefined;
  let foundVersion: number | null = null;
  let contentVersion: number | undefined;
  let deferredPublication: DeferredStateSchemaPublication | undefined;
  let ownership: OpenClawExternalStateOwnership | null = null;
  const result = (
    status: OpenClawStateSchemaPreflightResult["status"],
    details: { issues?: SqliteSchemaIssue[]; reason?: string; requiresWrite?: boolean } = {},
  ): OpenClawStateSchemaPreflightResult => ({
    ...base,
    foundVersion,
    ...(contentVersion !== undefined && contentVersion !== foundVersion ? { contentVersion } : {}),
    ...(deferredPublication ? { deferredPublication } : {}),
    ownership,
    issues: details.issues ?? [],
    status,
    requiresWrite: details.requiresWrite ?? false,
    ...(details.reason ? { reason: details.reason } : {}),
  });
  try {
    const inspectionPath = realpathSync.native(resolvedPath);
    const sidecars = ["-wal", "-shm", "-journal"].filter((suffix) =>
      existsSync(`${inspectionPath}${suffix}`),
    );
    if (sidecars.length > 0) {
      throw new Error(
        `SQLite preflight requires a consolidated snapshot with no sidecars; found ${sidecars.join(", ")}. Create a WAL-aware online backup and preflight the resulting standalone file.`,
      );
    }
    database = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(inspectionPath), {
      readOnly: true,
    });
    setSqliteBusyTimeout(database, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
    configureSqliteReadOnlyPragmas(database);
    foundVersion = readSqliteUserVersion(database);
    if (!Number.isSafeInteger(foundVersion) || foundVersion < 0) {
      throw new Error(
        `OpenClaw state database ${resolvedPath} has invalid schema version metadata.`,
      );
    }
    contentVersion =
      foundVersion > OPENCLAW_STATE_SCHEMA_VERSION
        ? foundVersion
        : readStateSchemaContentVersion(database);
    if (contentVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
      try {
        ownership = inspectOpenClawStateOwnershipFromDatabase(database, resolvedPath);
      } catch {
        // A newer release can own a newer metadata contract; the numeric refusal remains decisive.
      }
      return result("incompatible", {
        reason: createNewerSqliteSchemaVersionError(
          "OpenClaw state database",
          resolvedPath,
          contentVersion,
          OPENCLAW_STATE_SCHEMA_VERSION,
        ).message,
      });
    }
    assertSqliteIntegrity(database, resolvedPath);
    ownership = inspectOpenClawStateOwnershipFromDatabase(database, resolvedPath);
    if (readStateSchemaContentVersion(database) < OPENCLAW_STATE_SCHEMA_VERSION) {
      return result("migration-required", { requiresWrite: true });
    }
    if (foundVersion < contentVersion) {
      deferredPublication = describeDeferredStateSchemaPublication(
        readStateSchemaPublicationBlocker(database),
        resolvedPath,
        foundVersion,
        contentVersion,
      );
    }
    const { blockingIssues, startupRepairableIssues } = inspectCurrentStateStartupSchema(
      database,
      resolvedPath,
      foundVersion,
    );
    if (blockingIssues.length > 0) {
      return result("incompatible", { issues: blockingIssues });
    }
    assertNoLegacyStateRuntimeRepair(database, resolvedPath);
    return result(startupRepairableIssues.length > 0 ? "startup-repairable" : "exact", {
      issues: startupRepairableIssues,
      requiresWrite: startupRepairableIssues.length > 0,
    });
  } catch (error) {
    return result("indeterminate", { reason: formatErrorMessage(error) });
  } finally {
    database?.close();
  }
}
