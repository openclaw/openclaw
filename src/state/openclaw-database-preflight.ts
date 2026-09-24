import { existsSync, realpathSync, statSync } from "node:fs";
import nodePath from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveConfiguredAgentDatabaseCandidatePaths } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { hasNodeErrorCode } from "../infra/path-guards.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import type { SqliteSchemaIssue } from "../infra/sqlite-schema-contract.js";
import { readSqliteWriterAppVersion as readWriterAppVersion } from "../infra/sqlite-schema-header.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { hasStateDatabaseSourceExclusion } from "../infra/state-database-coordinator.js";
import {
  AgentDatabaseAdmissionError,
  canIsolateAgentDatabase,
  inspectAgentDatabaseAdmission,
  recordAgentDatabaseAdmissions,
} from "./agent-database-admission.js";
import { getAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import {
  readRetainedAgentDeletionsFromDatabase,
  type AgentDeletionJournalDisposition,
  type AgentDeletionJournalPurpose,
} from "./agent-deletion-journal.read.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { readAgentDatabasePreflightTargets } from "./openclaw-agent-db-registry.read.js";
import type { AgentSchemaInspection } from "./openclaw-agent-schema-inspection.js";
import { preflightAgentDatabasesBounded } from "./openclaw-database-preflight-agent-scheduler.js";
import { cleanupOpenClawStatePreflight } from "./openclaw-database-preflight-cleanup.js";
import {
  collectAgentDatabasePreflightTargets,
  recordAgentDatabaseRecoveryInspection,
} from "./openclaw-database-preflight-targets.js";
import {
  describeDeferredStateSchemaPublication,
  formatIndeterminateDatabaseReadiness,
  OpenClawDatabaseSchemaPreflightError,
} from "./openclaw-database-preflight.messages.js";
import type {
  AgentDatabasePreflightStats,
  DeferredStateSchemaPublication,
  OpenClawDatabaseSchemaPreflight,
  OpenClawDatabasePreflightOptions,
  OpenClawStateSchemaPreflightResult,
} from "./openclaw-database-preflight.types.js";
import { requestOpenClawAgentDatabaseQuickCheck } from "./openclaw-database-verify.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";
import { assertNoLegacyStateRuntimeRepair } from "./openclaw-state-db-fast-path.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  openClawStateMigrationAssertions,
} from "./openclaw-state-db-maintenance.js";
import { normalizeOpenClawStateSchemaReadError } from "./openclaw-state-db-schema-migration-required.js";
import { assertCanonicalStateSchemaShape } from "./openclaw-state-db-schema-repair.js";
import {
  readStateSchemaContentVersion,
  readStateSchemaMigrationVersion,
} from "./openclaw-state-db-schema-version.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  inspectOpenClawStateOwnershipFromDatabase,
  type OpenClawExternalStateOwnership,
} from "./openclaw-state-ownership.js";
import { inspectCurrentStateStartupSchema } from "./openclaw-state-schema-inspection.js";
import { readStateSchemaPublicationBlocker } from "./openclaw-state-schema-publication.js";

export type {
  DeferredStateSchemaPublication,
  IncompatibleOpenClawDatabase,
  IndeterminateOpenClawDatabase,
  OpenClawDatabaseSchemaPreflight,
} from "./openclaw-database-preflight.types.js";

export { OPENCLAW_DATABASE_SCHEMA_DOCS_URL } from "./openclaw-state-db.js";
export { OpenClawDatabaseSchemaPreflightError } from "./openclaw-database-preflight.messages.js";

/** Verify persisted runtime schemas before certifying repair or accepting restart. */
export async function assertOpenClawDatabasesReady(
  options: {
    env: NodeJS.ProcessEnv;
    onAgentInspection?: (stats: AgentDatabasePreflightStats) => void;
  } & (
    | {
        operation: "doctor";
        configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
        config?: OpenClawConfig;
        onDeferredSchemaPublication?: (publication: DeferredStateSchemaPublication) => void;
      }
    | { operation: "gateway-restart"; config?: OpenClawConfig }
    | { operation: "gateway-startup"; config: OpenClawConfig }
  ),
): Promise<void> {
  const schemas = await preflightOpenClawDatabaseSchemas(
    {
      env: options.env,
      onAgentInspection: options.onAgentInspection,
      verifyCurrentSchemaShape: true,
      ...(options.config
        ? {
            agentAdmissionConfig: options.config,
            // Inspect candidate owners from preserved snapshots: runtime target
            // resolution opens custom stores directly and can create WAL sidecars.
            configuredAgentDatabaseTargets: [],
            configuredAgentDatabaseCandidatePaths: resolveConfiguredAgentDatabaseCandidatePaths(
              options.config,
              { env: options.env },
            ),
          }
        : {}),
      ...(options.operation === "gateway-startup"
        ? { requireStartupMigrationReadiness: true }
        : {}),
      ...(options.operation === "doctor"
        ? { configuredAgentDatabaseTargets: options.configuredAgentDatabaseTargets }
        : {}),
    },
    options.operation === "doctor" ? "maintenance" : "runtime",
  );
  for (const refusal of schemas.agentRefusals ?? []) {
    if (
      !options.config ||
      ((refusal.code === "agent-database-ownership-mismatch" ||
        (options.operation === "gateway-startup" &&
          refusal.code !== "agent-database-inspection-pending")) &&
        !canIsolateAgentDatabase(options.config, refusal.agentId))
    ) {
      throw new AgentDatabaseAdmissionError(refusal);
    }
  }
  if (schemas.incompatible.length > 0) {
    throw new OpenClawDatabaseSchemaPreflightError(schemas.incompatible, {
      operation: options.operation,
    });
  }
  if (schemas.indeterminate.length === 0) {
    if (options.operation === "gateway-startup") {
      recordAgentDatabaseAdmissions(schemas.agentRefusals ?? [], {
        env: options.env,
        source: "startup",
      });
    }
    if (options.operation === "doctor") {
      for (const publication of schemas.deferredSchemaPublications ?? []) {
        options.onDeferredSchemaPublication?.(publication);
      }
    }
    return;
  }
  throw new Error(formatIndeterminateDatabaseReadiness(schemas.indeterminate, options.operation));
}

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
    database.exec(
      `PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS}; PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;`,
    );
    assertSqliteIntegrity(database, resolvedPath);
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
      return result("incompatible");
    }
    ownership = inspectOpenClawStateOwnershipFromDatabase(database, resolvedPath);
    if (readStateSchemaMigrationVersion(database) < OPENCLAW_STATE_SCHEMA_VERSION) {
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

/** Read schema headers and optionally verify current schema shape without repairing it. */
export async function preflightOpenClawDatabaseSchemas(
  options: OpenClawDatabasePreflightOptions,
  purpose: AgentDeletionJournalPurpose = "maintenance",
): Promise<OpenClawDatabaseSchemaPreflight> {
  options.signal?.throwIfAborted();
  const {
    supportedVersions = {
      state: OPENCLAW_STATE_SCHEMA_VERSION,
      agent: OPENCLAW_AGENT_SCHEMA_VERSION,
    },
  } = options;
  const result: OpenClawDatabaseSchemaPreflight = { incompatible: [], indeterminate: [] };
  const startup = options.requireStartupMigrationReadiness
    ? getAgentDatabaseStartupAdmission()
    : undefined;
  const prepareSchemaHeader = startup?.prepareSchemaHeaders(options.env);
  const readPreparedSchemaHeader =
    options.reuseStartupSchemaPreparation &&
    !options.requireStartupMigrationReadiness &&
    !options.verifyCurrentSchemaShape &&
    !options.agentAdmissionConfig
      ? getAgentDatabaseStartupAdmission()?.takePreparedSchemaHeaders(options.env)
      : undefined;
  const priorRefusals = startup?.captureRefusals(options.env);
  const statePath = nodePath.resolve(resolveOpenClawStateSqlitePath(options.env));
  let registeredDatabases: ReturnType<typeof readAgentDatabasePreflightTargets> = [];
  let deletionJournal: AgentDeletionJournalDisposition = {
    status: "unavailable",
    cause: "missing",
    reason: "shared state database missing",
  };
  let stateDatabase: DatabaseSync | undefined;
  let closeStateSchemaReadAdmission: (() => void) | undefined;
  let stateSnapshot: Awaited<ReturnType<typeof prepareSqliteReadOnlyLocation>> | undefined;
  const stateInspectionErrors: unknown[] = [];
  const inspectCandidatePresence = (
    databasePath: string,
  ): { status: "present" | "absent" } | { status: "indeterminate"; reason: string } => {
    try {
      statSync(databasePath);
      return { status: "present" };
    } catch (error) {
      return hasNodeErrorCode(error, "ENOENT")
        ? { status: "absent" }
        : { status: "indeterminate", reason: formatErrorMessage(error) };
    }
  };
  const statePresence = inspectCandidatePresence(statePath);
  if (statePresence.status === "indeterminate") {
    result.indeterminate.push({ kind: "state", path: statePath, reason: statePresence.reason });
    return result;
  }
  try {
    if (statePresence.status === "present") {
      // Even a read-only source connection can create WAL/SHM. The copy worker
      // preserves source artifacts and cannot release this process's writer locks.
      stateSnapshot = await prepareSqliteReadOnlyLocation(realpathSync.native(statePath), {
        preserveSourceArtifacts: true,
        signal: options.signal,
      });
      options.signal?.throwIfAborted();
      stateDatabase = openNodeSqliteDatabase(stateSnapshot.location, {
        readOnly: true,
      });
      closeStateSchemaReadAdmission = options.openStateSchemaReadAdmission?.(stateDatabase);
      stateDatabase.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
      const stateVersion = readSqliteUserVersion(stateDatabase);
      const contentVersion =
        stateVersion > supportedVersions.state
          ? stateVersion
          : readStateSchemaContentVersion(stateDatabase);
      const migrationVersion =
        contentVersion > supportedVersions.state
          ? contentVersion
          : readStateSchemaMigrationVersion(stateDatabase);
      if (migrationVersion < supportedVersions.state) {
        (result.pendingMigrations ??= []).push({
          kind: "state",
          path: statePath,
          foundVersion: stateVersion,
          supportedVersion: supportedVersions.state,
        });
      }
      if (contentVersion > supportedVersions.state) {
        const writerAppVersion = readWriterAppVersion(stateDatabase);
        result.incompatible.push({
          kind: "state",
          path: statePath,
          foundVersion: contentVersion,
          supportedVersion: supportedVersions.state,
          ...(writerAppVersion ? { writerAppVersion } : {}),
        });
      }
      if (stateVersion < contentVersion && migrationVersion === contentVersion) {
        (result.deferredSchemaPublications ??= []).push(
          describeDeferredStateSchemaPublication(
            readStateSchemaPublicationBlocker(stateDatabase),
            statePath,
            stateVersion,
            contentVersion,
          ),
        );
      }
      if (
        options.requireStartupMigrationReadiness &&
        contentVersion <= OPENCLAW_STATE_SCHEMA_VERSION
      ) {
        assertSqliteIntegrity(stateDatabase, statePath);
        assertCanonicalStateSchemaShape(stateDatabase, statePath);
        if (migrationVersion === OPENCLAW_STATE_SCHEMA_VERSION) {
          const { blockingIssues } = inspectCurrentStateStartupSchema(
            stateDatabase,
            statePath,
            stateVersion,
          );
          if (blockingIssues.length > 0) {
            throw new Error(
              `OpenClaw state database ${statePath} requires repair: ${blockingIssues.map((issue) => issue.message).join("; ")}; run openclaw doctor --fix.`,
            );
          }
        } else {
          openClawStateMigrationAssertions.get(migrationVersion)?.(stateDatabase, {
            pathname: statePath,
          });
        }
      } else if (
        options.verifyCurrentSchemaShape === true &&
        migrationVersion === OPENCLAW_STATE_SCHEMA_VERSION
      ) {
        try {
          assertOpenClawStateDatabaseForMaintenance(stateDatabase, { pathname: statePath });
        } catch (error) {
          stateInspectionErrors.push(error);
          result.indeterminate.push({
            kind: "state",
            path: statePath,
            reason: formatErrorMessage(error),
          });
        }
      }

      if (options.scope === "state") {
        return result;
      }
      try {
        registeredDatabases = readAgentDatabasePreflightTargets(stateDatabase, statePath);
        deletionJournal = readRetainedAgentDeletionsFromDatabase(stateDatabase, statePath, purpose);
      } catch (error) {
        stateInspectionErrors.push(error);
        result.indeterminate.push({
          kind: "state",
          path: statePath,
          reason: `agent database registry query failed: ${formatErrorMessage(error)}`,
        });
        return result;
      }
    }
  } catch (error) {
    // Accepted stop must not turn cancellation or failed cleanup into a
    // warn-and-continue result that launches the remaining startup runtime.
    const failure = normalizeOpenClawStateSchemaReadError(error, statePath);
    stateInspectionErrors.push(failure);
    if (options.signal?.aborted || options.requireStartupMigrationReadiness) {
      throw failure;
    }
    result.indeterminate.push({
      kind: "state",
      path: statePath,
      reason: formatErrorMessage(failure),
    });
    return result;
  } finally {
    await cleanupOpenClawStatePreflight({
      database: stateDatabase,
      closeAdmission: closeStateSchemaReadAdmission,
      snapshot: stateSnapshot,
      inspectionErrors: stateInspectionErrors,
    });
  }
  if (options.scope === "state") {
    return result;
  }
  const { candidates, isRetainedPath, failures, preparedDiscovery } =
    collectAgentDatabasePreflightTargets({
      ...options,
      registeredDatabases,
      deletionJournal,
      purpose,
      inspectCandidateOwners: Boolean(
        options.requireStartupMigrationReadiness || options.agentAdmissionConfig,
      ),
    });
  const recordRecoveryFailure = (pathname: string, reason: string) => {
    preparedDiscovery?.discovery.failures.push({ path: pathname, reason });
  };
  for (const failure of failures) {
    result.indeterminate.push({ kind: "agent", ...failure });
  }
  const inspectionTargets = candidates
    .map(({ agentId, path, holdForDeletionRecovery }) => ({
      agentId,
      path,
      holdForDeletionRecovery,
      presence: inspectCandidatePresence(path),
    }))
    .filter((row) => row.presence.status !== "absent");
  const admittedAgentIds = options.agentAdmissionConfig
    ? new Set(listAgentIds(options.agentAdmissionConfig))
    : undefined;
  const stats = await preflightAgentDatabasesBounded(
    inspectionTargets,
    async (row, inspection, claimAgentTarget, inspectSchema) => {
      const agentPath = row.path;
      if (startup?.reuseRefusal(row, inspection, priorRefusals)) {
        return;
      }
      const { presence } = row;
      if (presence.status === "indeterminate") {
        if (row.holdForDeletionRecovery) {
          recordRecoveryFailure(agentPath, presence.reason);
          return;
        }
        if (!startup?.recordInspectionFailure(row, inspection, new Error(presence.reason))) {
          inspection.indeterminate.push({
            kind: "agent",
            path: agentPath,
            reason: presence.reason,
          });
        }
        return;
      }
      let agentSnapshot: Awaited<ReturnType<typeof prepareSqliteReadOnlyLocation>> | undefined;
      try {
        // Preserve SQLite's filesystem traversal through symlink/.. locators.
        const realAgentPath = realpathSync.native(agentPath);
        if (row.agentId === undefined && isRetainedPath(realAgentPath)) {
          return;
        }
        if (!claimAgentTarget(realAgentPath, row.agentId)) {
          return;
        }
        let schemaInspection: AgentSchemaInspection | null =
          readPreparedSchemaHeader?.(realAgentPath, supportedVersions.agent) ?? null;
        const recordPreparedSchemaHeader = prepareSchemaHeader?.(realAgentPath);
        const inspectOwnership =
          row.holdForDeletionRecovery ||
          (row.agentId !== undefined && admittedAgentIds?.has(row.agentId) === true);
        const schemaInput = {
          pathname: realAgentPath,
          agentId: row.agentId,
          supportedVersion: supportedVersions.agent,
          inspectOwnership,
          verifyCurrentSchemaShape: row.holdForDeletionRecovery
            ? false
            : options.verifyCurrentSchemaShape,
          requireStartupMigrationReadiness: row.holdForDeletionRecovery
            ? false
            : options.requireStartupMigrationReadiness,
          startupIntegrityStateDir: options.requireStartupMigrationReadiness
            ? resolveStateDir(options.env)
            : undefined,
        };
        // Unprepared agents use the slot's reader, including header-only Doctor checks.
        if (!schemaInspection && !hasStateDatabaseSourceExclusion(realAgentPath)) {
          schemaInspection = await inspectSchema(schemaInput, options.signal);
        }
        if (!schemaInspection) {
          // Raw private recovery reuses the slot's snapshot worker without the
          // native async-backup/IPC stall; the parent retains cleanup ownership.
          agentSnapshot = await prepareSqliteReadOnlyLocation(realAgentPath, {
            preserveSourceArtifacts: true,
            signal: options.signal,
          });
          options.signal?.throwIfAborted();
          schemaInspection = await inspectSchema(
            schemaInput,
            options.signal,
            agentSnapshot.location,
          );
        }
        if (!schemaInspection) {
          throw new Error(`Agent database inspection returned no result: ${agentPath}`);
        }
        const { version: agentVersion, writerAppVersion, agentSchemaMeta } = schemaInspection;
        if (row.holdForDeletionRecovery) {
          recordAgentDatabaseRecoveryInspection(
            preparedDiscovery,
            agentPath,
            realAgentPath,
            schemaInspection,
          );
          return;
        }
        if (agentVersion <= supportedVersions.agent && inspectOwnership && row.agentId) {
          const refusal = inspectAgentDatabaseAdmission({
            agentId: row.agentId,
            path: agentPath,
            metadata: agentSchemaMeta ?? null,
          });
          if (refusal) {
            (inspection.agentRefusals ??= []).push(refusal);
            return;
          }
        }
        if (agentVersion < supportedVersions.agent) {
          (inspection.pendingMigrations ??= []).push({
            kind: "agent",
            path: agentPath,
            ...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
            foundVersion: agentVersion,
            supportedVersion: supportedVersions.agent,
          });
        }
        if (schemaInspection?.failure) {
          throw schemaInspection.failure;
        }
        if (schemaInspection?.reason) {
          if (startup) {
            throw new Error(schemaInspection.reason);
          }
          inspection.indeterminate.push({
            kind: "agent",
            path: agentPath,
            reason: schemaInspection.reason,
            ...(options.requireStartupMigrationReadiness ? { agentId: row.agentId } : {}),
          });
          return;
        }
        if (agentVersion > supportedVersions.agent) {
          inspection.incompatible.push({
            kind: "agent",
            path: agentPath,
            ...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
            foundVersion: agentVersion,
            supportedVersion: supportedVersions.agent,
            ...(writerAppVersion ? { writerAppVersion } : {}),
          });
        }
        if (schemaInspection.integrityGateOutcome === "cached") {
          requestOpenClawAgentDatabaseQuickCheck({
            path: agentPath,
            env: options.env ?? process.env,
          });
        }
        recordPreparedSchemaHeader?.(agentVersion);
      } catch (error) {
        if (options.signal?.aborted) {
          throw error;
        }
        if (row.holdForDeletionRecovery) {
          recordRecoveryFailure(agentPath, formatErrorMessage(error));
          return;
        }
        if (startup?.recordInspectionFailure(row, inspection, error)) {
          return;
        }
        if (options.requireStartupMigrationReadiness) {
          throw error;
        }
        inspection.indeterminate.push({
          kind: "agent",
          path: agentPath,
          reason: formatErrorMessage(error),
        });
      } finally {
        if (agentSnapshot) {
          let failure: { error: unknown } | undefined;
          try {
            if (!(await agentSnapshot.cleanupAsync())) {
              failure = {
                error: new Error(
                  `SQLite read-only worker snapshot cleanup failed: ${agentSnapshot.location}`,
                ),
              };
            }
          } catch (error) {
            failure = { error };
          }
          if (failure && !startup?.recordInspectionFailure(row, inspection, failure.error)) {
            if (row.holdForDeletionRecovery) {
              recordRecoveryFailure(agentPath, formatErrorMessage(failure.error));
            } else {
              inspection.indeterminate.push({
                kind: "agent",
                path: agentPath,
                reason: formatErrorMessage(failure.error),
              });
            }
          }
        }
      }
    },
    result,
    options.signal,
    startup?.scheduling(options.env),
  );
  if (preparedDiscovery) {
    options.onAgentDatabaseDiscovery?.(preparedDiscovery);
  }
  options.onAgentInspection?.(stats);
  return result;
}
