import { realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "./openclaw-agent-db-maintenance.js";
import {
  assertCanonicalAgentPersistenceVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import type {
  IncompatibleOpenClawDatabase,
  IndeterminateOpenClawDatabase,
} from "./openclaw-database-preflight.types.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

export type OpenClawAgentDatabaseInspectionTarget = { agentId?: string; path: string };

type CandidatePresence =
  | { status: "absent" | "present" }
  | { status: "indeterminate"; reason: string };

type AgentDatabaseSchemaInspection = {
  incompatible?: IncompatibleOpenClawDatabase;
  indeterminate?: IndeterminateOpenClawDatabase;
  pendingMigration?: Omit<IncompatibleOpenClawDatabase, "writerAppVersion">;
};

// Snapshot preparation can be disk-heavy; overlap one additional agent
// without fanning out across every registered database.
const AGENT_DATABASE_PREFLIGHT_CONCURRENCY = 2;

function readWriterAppVersion(database: DatabaseSync): string | undefined {
  try {
    const row = database
      .prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
      .get() as { app_version?: unknown } | undefined;
    return typeof row?.app_version === "string" && row.app_version.length > 0
      ? row.app_version
      : undefined;
  } catch {
    return undefined;
  }
}

export async function preflightOpenClawAgentDatabaseTargets(params: {
  inspectionTargets: readonly OpenClawAgentDatabaseInspectionTarget[];
  inspectCandidatePresence: (databasePath: string) => CandidatePresence;
  requireStartupMigrationReadiness?: boolean;
  signal?: AbortSignal;
  supportedVersion: number;
  verifyCurrentSchemaShape?: boolean;
}): Promise<{
  incompatible: IncompatibleOpenClawDatabase[];
  indeterminate: IndeterminateOpenClawDatabase[];
  pendingMigrations: Omit<IncompatibleOpenClawDatabase, "writerAppVersion">[];
}> {
  const inspectedAgentPaths = new Set<string>();
  const inspectedAgentTargets = new Set<string>();
  const inspectAgent = async (
    row: OpenClawAgentDatabaseInspectionTarget,
  ): Promise<AgentDatabaseSchemaInspection | undefined> => {
    const agentPath = row.path;
    const presence = params.inspectCandidatePresence(agentPath);
    if (presence.status === "absent") {
      return undefined;
    }
    if (presence.status === "indeterminate") {
      return { indeterminate: { kind: "agent", path: agentPath, reason: presence.reason } };
    }
    let agentDatabase: DatabaseSync | undefined;
    let agentSnapshot: Awaited<ReturnType<typeof prepareSqliteReadOnlyLocation>> | undefined;
    try {
      // Preserve SQLite's filesystem traversal through symlink/.. locators.
      const realAgentPath = realpathSync.native(agentPath);
      const inspectionKey = `${realAgentPath}\0${row.agentId ?? ""}`;
      if (
        inspectedAgentTargets.has(inspectionKey) ||
        (row.agentId === undefined && inspectedAgentPaths.has(realAgentPath))
      ) {
        return undefined;
      }
      inspectedAgentPaths.add(realAgentPath);
      inspectedAgentTargets.add(inspectionKey);
      // Live agents keep committing during inspection. Online backup preserves
      // database/WAL contents while allowing SQLite to update SHM read marks.
      agentSnapshot = await prepareSqliteReadOnlyLocation(realAgentPath, { signal: params.signal });
      params.signal?.throwIfAborted();
      agentDatabase = openNodeSqliteDatabase(agentSnapshot.location, { readOnly: true });
      agentDatabase.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
      const agentVersion = readSqliteUserVersion(agentDatabase);
      const pendingMigration =
        agentVersion < params.supportedVersion
          ? {
              kind: "agent" as const,
              path: agentPath,
              ...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
              foundVersion: agentVersion,
              supportedVersion: params.supportedVersion,
            }
          : undefined;
      if (agentVersion <= params.supportedVersion) {
        if (params.requireStartupMigrationReadiness) {
          assertSqliteIntegrity(agentDatabase, agentPath);
          assertCanonicalAgentPersistenceVersion(agentDatabase, agentPath, agentVersion);
        }
        const agentId =
          row.agentId ??
          (params.requireStartupMigrationReadiness
            ? readExistingAgentSchemaMeta(agentDatabase)?.agentId
            : undefined);
        if (
          params.verifyCurrentSchemaShape === true &&
          agentId != null &&
          (!params.requireStartupMigrationReadiness || agentVersion > 0)
        ) {
          assertOpenClawAgentDatabaseForMaintenance(agentDatabase, {
            agentId,
            pathname: agentPath,
          });
        }
        return pendingMigration ? { pendingMigration } : undefined;
      }
      const writerAppVersion = readWriterAppVersion(agentDatabase);
      return {
        incompatible: {
          kind: "agent",
          path: agentPath,
          ...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
          foundVersion: agentVersion,
          supportedVersion: params.supportedVersion,
          ...(writerAppVersion ? { writerAppVersion } : {}),
        },
      };
    } catch (error) {
      if (params.signal?.aborted || params.requireStartupMigrationReadiness) {
        throw error;
      }
      return {
        indeterminate: { kind: "agent", path: agentPath, reason: formatErrorMessage(error) },
      };
    } finally {
      try {
        agentDatabase?.close();
      } finally {
        agentSnapshot?.cleanup();
      }
    }
  };

  const inspections: Array<AgentDatabaseSchemaInspection | undefined> = [];
  const failures = new Map<number, unknown>();
  let nextInspectionIndex = 0;
  const worker = async (): Promise<void> => {
    while (!params.signal?.aborted && failures.size === 0) {
      const index = nextInspectionIndex;
      nextInspectionIndex += 1;
      const row = params.inspectionTargets[index];
      if (!row) {
        return;
      }
      try {
        inspections[index] = await inspectAgent(row);
      } catch (error) {
        failures.set(index, error);
        return;
      }
    }
  };

  // Stop admitting work after cancellation or a fatal error, then join every
  // active worker so its database close and snapshot cleanup finish first.
  await Promise.all(
    Array.from(
      { length: Math.min(AGENT_DATABASE_PREFLIGHT_CONCURRENCY, params.inspectionTargets.length) },
      () => worker(),
    ),
  );
  for (let index = 0; index < params.inspectionTargets.length; index += 1) {
    const failure = failures.get(index);
    if (failure !== undefined) {
      throw failure;
    }
  }
  params.signal?.throwIfAborted();

  const result: {
    incompatible: IncompatibleOpenClawDatabase[];
    indeterminate: IndeterminateOpenClawDatabase[];
    pendingMigrations: Omit<IncompatibleOpenClawDatabase, "writerAppVersion">[];
  } = { incompatible: [], indeterminate: [], pendingMigrations: [] };
  for (const inspection of inspections) {
    if (inspection?.pendingMigration) {
      result.pendingMigrations.push(inspection.pendingMigration);
    }
    if (inspection?.incompatible) {
      result.incompatible.push(inspection.incompatible);
    }
    if (inspection?.indeterminate) {
      result.indeterminate.push(inspection.indeterminate);
    }
  }
  return result;
}
