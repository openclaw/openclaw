import { realpathSync } from "node:fs";
import nodePath from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  isConfiguredAgentDatabaseTarget,
  resolveConfiguredAgentDatabaseCandidatePaths,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { adoptSqliteSchemaContracts } from "../infra/sqlite-schema-contract.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  AgentDatabaseAdmissionError,
  canIsolateAgentDatabase,
  inspectAgentDatabaseAdmission,
  recordAgentDatabaseAdmissions,
} from "./agent-database-admission.js";
import { getAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import type {
  AgentDeletionJournalDisposition,
  AgentDeletionJournalPurpose,
} from "./agent-deletion-journal.types.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { createAgentSchemaInspectionWorker } from "./openclaw-agent-schema-inspection-worker.js";
import type { AgentSchemaInspection } from "./openclaw-agent-schema-inspection.js";
import { preflightAgentDatabasesBounded } from "./openclaw-database-preflight-agent-scheduler.js";
import { cleanupOpenClawStatePreflight } from "./openclaw-database-preflight-cleanup.js";
import {
  collectAgentDatabasePreflightTargets,
  inspectDatabaseCandidatePresence,
  recordAgentDatabaseRecoveryInspection,
} from "./openclaw-database-preflight-targets.js";
import {
  formatIndeterminateDatabaseReadiness,
  OpenClawDatabaseSchemaPreflightError,
} from "./openclaw-database-preflight.messages.js";
import type {
  AgentDatabasePreflightStats,
  DeferredStateSchemaPublication,
  IndeterminateOpenClawDatabase,
  OpenClawDatabaseSchemaPreflight,
  OpenClawDatabasePreflightOptions,
} from "./openclaw-database-preflight.types.js";
import { requestOpenClawAgentDatabaseIntegrityCheck } from "./openclaw-database-verify.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";
import { getActiveOpenClawStateDatabaseReadSnapshot } from "./openclaw-state-db-readonly.js";
import { normalizeOpenClawStateSchemaReadError } from "./openclaw-state-db-schema-migration-required.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  captureStateSchemaInspectionContracts,
  inspectStateDatabaseSchema,
  type StateSchemaInspection,
  type StateSchemaInspectionInput,
} from "./openclaw-state-schema-preflight.js";

export type {
  DeferredStateSchemaPublication,
  IncompatibleOpenClawDatabase,
  IndeterminateOpenClawDatabase,
  OpenClawDatabaseSchemaPreflight,
} from "./openclaw-database-preflight.types.js";

export { OPENCLAW_DATABASE_SCHEMA_DOCS_URL } from "./openclaw-state-db.js";
export { preflightOpenClawStateDatabasePath } from "./openclaw-database-preflight-state-path.js";
export { OpenClawDatabaseSchemaPreflightError } from "./openclaw-database-preflight.messages.js";

// Public readiness rows stay serializable; their original failures belong to this inspection.
const indeterminateCauses = new WeakMap<IndeterminateOpenClawDatabase, unknown>();

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
        onVerified?: (schemas: OpenClawDatabaseSchemaPreflight) => void;
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
  const failures: unknown[] = [];
  for (const refusal of schemas.agentRefusals ?? []) {
    if (
      !options.config ||
      ((refusal.code === "agent-database-ownership-mismatch" ||
        (options.operation === "gateway-startup" &&
          refusal.code !== "agent-database-inspection-pending")) &&
        !canIsolateAgentDatabase(options.config, refusal.agentId))
    ) {
      failures.push(new AgentDatabaseAdmissionError(refusal));
    }
  }
  if (schemas.incompatible.length > 0) {
    failures.push(
      new OpenClawDatabaseSchemaPreflightError(schemas.incompatible, {
        operation: options.operation,
      }),
    );
  }
  if (schemas.indeterminate.length > 0) {
    const causes = schemas.indeterminate.flatMap((row) =>
      indeterminateCauses.has(row) ? [indeterminateCauses.get(row)] : [],
    );
    // Preserve a single strict inspection's typed refusal; multiple rows keep the complete report.
    failures.push(
      options.operation === "gateway-startup" &&
        schemas.indeterminate.length === 1 &&
        causes.length === 1
        ? causes[0]
        : new Error(
            formatIndeterminateDatabaseReadiness(schemas.indeterminate, options.operation),
            {
              cause: new AggregateError(causes),
            },
          ),
    );
  }
  if (failures.length > 0) {
    // A failed read must not hide another required store's proven repair or version refusal.
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, failures.map((error) => formatErrorMessage(error)).join("\n"));
  }
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
    options.onVerified?.(schemas);
  }
}

/** Read schema headers and optionally verify current schema shape without repairing it. */
export async function preflightOpenClawDatabaseSchemas(
  options: OpenClawDatabasePreflightOptions,
  purpose: AgentDeletionJournalPurpose = "maintenance",
): Promise<OpenClawDatabaseSchemaPreflight> {
  options.signal?.throwIfAborted();
  const supportedVersions = options.supportedVersions ?? {
    state: OPENCLAW_STATE_SCHEMA_VERSION,
    agent: OPENCLAW_AGENT_SCHEMA_VERSION,
  };
  const result: OpenClawDatabaseSchemaPreflight = { incompatible: [], indeterminate: [] };
  const startup = options.requireStartupMigrationReadiness
    ? getAgentDatabaseStartupAdmission()
    : undefined;
  const admissionConfig = options.agentAdmissionConfig;
  const admittedAgentIds = new Set(admissionConfig ? listAgentIds(admissionConfig) : []);
  const scheduling = startup?.scheduling(
    options.env,
    admissionConfig
      ? (options.configuredAgentDatabaseCandidatePaths ??
          resolveConfiguredAgentDatabaseCandidatePaths(admissionConfig, { env: options.env }))
      : [],
    admittedAgentIds,
  );
  const prepareSchemaHeader = startup?.prepareSchemaHeaders(options.env);
  const preparedStartup =
    options.reuseStartupSchemaPreparation &&
    !options.requireStartupMigrationReadiness &&
    !options.verifyCurrentSchemaShape
      ? getAgentDatabaseStartupAdmission()
      : undefined;
  const readPreparedSchemaHeader = preparedStartup?.takePreparedSchemaHeaders(options.env);
  const refusalOwner = startup ?? preparedStartup;
  const priorRefusals = refusalOwner?.captureRefusals(options.env);
  const statePath = nodePath.resolve(resolveOpenClawStateSqlitePath(options.env));
  let registeredDatabases: { agentId: string; path: string }[] = [];
  let deletionJournal: AgentDeletionJournalDisposition = {
    status: "unavailable",
    cause: "missing",
    reason: "shared state database missing",
  };
  let stateDatabase: DatabaseSync | undefined;
  let closeStateSchemaReadAdmission: (() => void) | undefined;
  let stateSnapshot: Awaited<ReturnType<typeof prepareSqliteReadOnlyLocation>> | undefined;
  const stateInspectionErrors: unknown[] = [];
  const statePresence = inspectDatabaseCandidatePresence(statePath);
  if (statePresence.status === "indeterminate") {
    result.indeterminate.push({ kind: "state", path: statePath, reason: statePresence.reason });
    return result;
  }
  try {
    if (statePresence.status === "present") {
      // Admission must inspect the same private generation as config recovery and discovery.
      // Without an enclosing snapshot, the copy worker still owns native source opens.
      let stateLocation = getActiveOpenClawStateDatabaseReadSnapshot({
        env: options.env,
      })?.location;
      if (stateLocation === undefined) {
        stateSnapshot = await prepareSqliteReadOnlyLocation(realpathSync.native(statePath), {
          preserveSourceArtifacts: options.preserveSourceArtifacts ?? true,
          allowLiveOwner: options.preserveSourceArtifacts !== false,
          signal: options.signal,
        });
        stateLocation = stateSnapshot.location;
      }
      options.signal?.throwIfAborted();
      const input: StateSchemaInspectionInput = {
        pathname: statePath,
        supportedVersion: supportedVersions.state,
        requireStartupMigrationReadiness: options.requireStartupMigrationReadiness,
        verifyCurrentSchemaShape: options.verifyCurrentSchemaShape,
        scope: options.scope,
        purpose,
      };
      let inspection: StateSchemaInspection;
      if (
        purpose === "runtime" &&
        !options.requireStartupMigrationReadiness &&
        !options.openStateSchemaReadAdmission
      ) {
        await using reader = createAgentSchemaInspectionWorker();
        inspection = await reader.inspectState(
          { ...input, schemaContracts: captureStateSchemaInspectionContracts() },
          options.signal,
          stateLocation,
        );
        adoptSqliteSchemaContracts(inspection.schemaContracts ?? []);
      } else {
        // Boot admission exposes this native handle to its enclosing migration owner.
        stateDatabase = openNodeSqliteDatabase(stateLocation, { readOnly: true });
        closeStateSchemaReadAdmission = options.openStateSchemaReadAdmission?.(stateDatabase);
        stateDatabase.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
        inspection = inspectStateDatabaseSchema(stateDatabase, input);
      }
      Object.assign(result, inspection.schemas);
      stateInspectionErrors.push(...inspection.inspectionErrors);
      if (options.scope === "state" || !inspection.deletionJournal) {
        return result;
      }
      registeredDatabases = inspection.registeredDatabases ?? [];
      deletionJournal = inspection.deletionJournal;
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
  const skipped = new Set<string>();
  const inspectionTargets = candidates
    .filter((row) => {
      if (
        !admissionConfig ||
        !(options.requireStartupMigrationReadiness || options.reuseStartupSchemaPreparation) ||
        isConfiguredAgentDatabaseTarget(admissionConfig, row.agentId, row.path, options.env)
      ) {
        return true;
      }
      if (options.requireStartupMigrationReadiness && !skipped.has(row.path)) {
        createSubsystemLogger("state/agent-admission").warn(
          `Skipped ${nodePath.basename(row.path)}: unconfigured agent database; run openclaw doctor to inspect retained data.`,
        );
        skipped.add(row.path);
      }
      return false;
    })
    .map((row) => Object.assign({}, row, { presence: inspectDatabaseCandidatePresence(row.path) }))
    .filter((row) => row.presence.status !== "absent");
  const stats = await preflightAgentDatabasesBounded(
    inspectionTargets,
    async (row, inspection, claimAgentTarget, inspectSchema) => {
      const agentPath = row.path;
      if (refusalOwner?.reuseRefusal(row, inspection, priorRefusals)) {
        return undefined;
      }
      const { presence } = row;
      if (presence.status === "indeterminate") {
        if (row.holdForDeletionRecovery) {
          recordRecoveryFailure(agentPath, presence.reason);
          return undefined;
        }
        if (!startup?.recordInspectionFailure(row, inspection, new Error(presence.reason))) {
          inspection.indeterminate.push({
            kind: "agent",
            path: agentPath,
            reason: presence.reason,
          });
        }
        return undefined;
      }
      let agentSnapshot: Awaited<ReturnType<typeof prepareSqliteReadOnlyLocation>> | undefined;
      try {
        // Preserve SQLite's filesystem traversal through symlink/.. locators.
        const realAgentPath = realpathSync.native(agentPath);
        if (row.agentId === undefined && isRetainedPath(realAgentPath)) {
          return undefined;
        }
        if (!claimAgentTarget(realAgentPath, row.agentId)) {
          return undefined;
        }
        let schemaInspection: AgentSchemaInspection | null =
          readPreparedSchemaHeader?.(realAgentPath, supportedVersions.agent) ?? null;
        const recordPreparedSchemaHeader = prepareSchemaHeader?.(realAgentPath);
        const inspectOwnership =
          row.holdForDeletionRecovery ||
          (row.agentId !== undefined && admittedAgentIds.has(row.agentId));
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
          deferRuntimeIntegrity:
            purpose === "runtime" &&
            options.preserveSourceArtifacts !== true &&
            scheduling?.canDefer(row),
          startupIntegrityStateDir: options.requireStartupMigrationReadiness
            ? resolveStateDir(options.env)
            : undefined,
        };
        // Native read-only opens can change source SHM read marks. Explicit
        // artifact preservation must use the WAL-aware private snapshot below.
        if (!schemaInspection && options.preserveSourceArtifacts !== true) {
          schemaInspection = await inspectSchema(schemaInput, options.signal);
        }
        if (!schemaInspection) {
          // The parent retains cleanup ownership for the isolated snapshot worker.
          agentSnapshot = await prepareSqliteReadOnlyLocation(realAgentPath, {
            preserveSourceArtifacts: options.preserveSourceArtifacts ?? true,
            allowLiveOwner: options.preserveSourceArtifacts !== false,
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
          return undefined;
        }
        if (agentVersion <= supportedVersions.agent && inspectOwnership && row.agentId) {
          const refusal = inspectAgentDatabaseAdmission({
            agentId: row.agentId,
            path: agentPath,
            metadata: agentSchemaMeta ?? null,
          });
          if (refusal) {
            (inspection.agentRefusals ??= []).push(refusal);
            return undefined;
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
        if (schemaInspection.failure && !schemaInspection.reason) {
          throw schemaInspection.failure;
        }
        if (schemaInspection?.reason) {
          if (startup) {
            throw schemaInspection.failure ?? new Error(schemaInspection.reason);
          }
          const failure: IndeterminateOpenClawDatabase = {
            kind: "agent",
            path: agentPath,
            reason: schemaInspection.reason,
            ...(options.requireStartupMigrationReadiness ? { agentId: row.agentId } : {}),
          };
          if (schemaInspection.failure) {
            indeterminateCauses.set(failure, schemaInspection.failure);
          }
          inspection.indeterminate.push(failure);
          return undefined;
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
          requestOpenClawAgentDatabaseIntegrityCheck({
            check: "quick",
            path: agentPath,
            env: options.env ?? process.env,
          });
        }
        recordPreparedSchemaHeader?.(schemaInspection);
        return schemaInspection.preparationPending ? "defer" : undefined;
      } catch (error) {
        if (options.signal?.aborted) {
          throw error;
        }
        if (row.holdForDeletionRecovery) {
          recordRecoveryFailure(agentPath, formatErrorMessage(error));
          return undefined;
        }
        if (startup?.recordInspectionFailure(row, inspection, error)) {
          return undefined;
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
      return undefined;
    },
    result,
    options.signal,
    scheduling,
  );
  if (preparedDiscovery) {
    options.onAgentDatabaseDiscovery?.(preparedDiscovery);
  }
  options.onAgentInspection?.(stats);
  return result;
}
