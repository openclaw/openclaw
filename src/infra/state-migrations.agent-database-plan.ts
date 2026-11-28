/**
 * Read-only plan for the Doctor agent database migration and maintenance
 * (`migrateLegacyMediaPersistence`, then `migrateSessionColdNavigation`).
 *
 * Each condition below is one decision the writing pass acts on, answered per
 * database as work, none or undecidable. The plan opens agent databases read-only
 * only: no read-write open, lease, seal invalidation, write transaction, file
 * creation by its own code, or copy. A condition it cannot read is undecidable,
 * and only an all-`none` plan lets a caller skip a database.
 */
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { measureGatewayBootstrapStep } from "../cli/startup-trace.js";
import { storeReadsNeedCopies } from "../commands/doctor-live-store-pending.js";
import type { DoctorMaintenancePending } from "../commands/doctor-maintenance-pending.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { isArtifactPreservingStateRead } from "../state/artifact-preserving-state-reads.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { agentEngineInput } from "../state/openclaw-agent-db-engine.js";
import { agentDatabaseLifecycle } from "../state/openclaw-agent-db-lifecycle.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { hasCurrentAgentSchemaMetadata } from "../state/openclaw-agent-db-metadata-write.js";
import { agentDatabasePermissionsNeedRepair } from "../state/openclaw-agent-db-permissions.js";
import { openOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-open.js";
import {
  invalidateRegisteredAgentDatabasesMemo,
  listOpenClawRegisteredAgentDatabases,
} from "../state/openclaw-agent-db-registry-listing.js";
import {
  assertOpenClawAgentCurrentRuntimeSchema,
  hasPendingCurrentVersionAgentDatabaseMigration,
  hasPendingSessionKeyContractSchema,
} from "../state/openclaw-agent-db-schema-helpers.js";
import {
  hasPendingSessionAdditiveSchema,
  hasPendingSessionEntryValidity,
} from "../state/openclaw-agent-db-session-migrations.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { readOpenClawDatabaseQuarantineFailure } from "../state/openclaw-quarantine-store.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import { resolveSchemaMigrationIntegrityCheck } from "../state/schema-migration-backup-scope.js";
import { isTruthyEnvValue } from "./env.js";
import { findCanonicalSqliteIndexDrift } from "./sqlite-index-schema.js";
import { runSqliteIntegrityOperationInWorker } from "./sqlite-integrity-operation.js";
import { sqliteIntegrityCheckSteps } from "./sqlite-integrity.js";
import { sqlitePlannerStatisticsNeedRefresh } from "./sqlite-planner-statistics.js";
import { resolveSqliteInspectionSignal } from "./sqlite-readonly-worker-context.js";
import { createSqliteTableContractReader } from "./sqlite-schema-contract.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { hasMisplacedAgentDatabaseCopies } from "./state-migrations.agent-owner-recovery.js";
import { hasPendingSessionColdNavigation } from "./state-migrations.cold-navigation.js";
import { transcriptArchiveNeedsMigration } from "./state-migrations.media-persistence-archive-source.js";
import { hasMediaRowsMigrationReceipt } from "./state-migrations.media-persistence-inspection.js";
import {
  listTranscriptArchives,
  prepareAgentDatabaseMigrationDiscovery,
  type AgentDatabaseMigrationTarget,
  type PreparedAgentDatabaseMigrationDiscovery,
} from "./state-migrations.media-persistence-targets.js";
import { transformMediaArchiveContent } from "./state-migrations.media-persistence-transform.js";
import {
  MEDIA_ARCHIVE_VERIFICATION_KEY,
  migrateCanonicalTranscriptArchives,
} from "./state-migrations.transcript-directives-archives.js";

/** Inventory decisions taken once, before any database is visited. */
type AgentDatabaseDiscoveryCondition =
  /** Registry removals, pending deletions, held stores, failures or warnings. */
  | "discovery"
  /** A locator selects a database another agent owns (`recoverMisplacedAgentDatabaseCopies`). */
  | "misplaced-copies";

/** Per-database decisions, in the order the writing pass reaches them. */
type AgentDatabaseCondition =
  /** PostgreSQL stores and update-in-progress runs take their own paths. */
  | "engine"
  /** user_version and ownership metadata below, above or out of step with this build. */
  | "schema-version"
  /** Schema ownership metadata that names another agent or is missing. */
  | "schema-owner"
  /** Same-version additive tables, columns, triggers and retired shapes (`ensureAgentSchema`). */
  | "schema-additive"
  /** `session_nodes` rows still classified `entry_valid = 0`. */
  | "entry-validity"
  /** The primary `schema_meta` row (`persistAgentSchemaMetadata` is a no-op). */
  | "schema-metadata"
  /** Missing or drifted canonical indexes (`repairCanonicalSqliteIndexes`). */
  | "canonical-indexes"
  /** Canonical runtime schema validation after index convergence. */
  | "runtime-schema"
  /** Physical integrity, checked as the writing pass checks it but on a read-only connection. */
  | "integrity"
  /** A process terminal latch or persisted quarantine record to clear. */
  | "quarantine"
  /** Directory and file modes (`ensureOpenClawAgentDatabasePermissions`). */
  | "permissions"
  /** The `agent_databases` row's path and schema version. `last_seen_at` alone is not work. */
  | "registry"
  /** The media rows migration receipt. */
  | "media-rows"
  /** Session entry state the writing pass requires to be prepared first. */
  | "entry-state-preparation"
  /** Canonical archive blobs, their files, the recovery journal and the verification receipt. */
  | "transcript-archives"
  /** Legacy archive files beside the database that still carry Media* fields. */
  | "archive-files"
  /** Planner statistics `PRAGMA optimize` would refresh. */
  | "planner-statistics"
  /** Cold archives without retained navigation (`migrateSessionColdNavigation`). */
  | "cold-navigation";

type AgentDatabaseMaintenancePlan = {
  agentId: string;
  path: string;
  realPath: string;
  conditions: Partial<Record<AgentDatabaseCondition, DoctorMaintenancePending>>;
  pending: DoctorMaintenancePending;
};

export type AgentDatabaseMigrationPlan = {
  discovery: Partial<Record<AgentDatabaseDiscoveryCondition, DoctorMaintenancePending>>;
  databases: AgentDatabaseMaintenancePlan[];
  pending: DoctorMaintenancePending;
};

/** The cold navigation pass owns this condition; the media pass owns every other. */
const COLD_NAVIGATION_CONDITIONS: ReadonlySet<string> = new Set<AgentDatabaseCondition>([
  "cold-navigation",
]);

function combineAgentDatabasePending(
  answers: Iterable<DoctorMaintenancePending | undefined>,
): DoctorMaintenancePending {
  let combined: DoctorMaintenancePending = "none";
  for (const answer of answers) {
    if (answer === "work") {
      return "work";
    }
    if (answer === "undecidable") {
      combined = "undecidable";
    }
  }
  return combined;
}

/** Whether the media pass may leave this database untouched (every condition but its own none). */
function agentDatabaseMediaPassIsNoop(plan: AgentDatabaseMaintenancePlan): boolean {
  return (
    combineAgentDatabasePending(
      Object.entries(plan.conditions)
        .filter(([condition]) => !COLD_NAVIGATION_CONDITIONS.has(condition))
        .map(([, answer]) => answer),
    ) === "none"
  );
}

function decide(work: boolean): DoctorMaintenancePending {
  return work ? "work" : "none";
}

function readCondition(read: () => boolean): DoctorMaintenancePending {
  try {
    return decide(read());
  } catch {
    // The writing pass reports this failure; keep it on that path.
    return "work";
  }
}

async function readAsyncCondition(read: () => Promise<boolean>): Promise<DoctorMaintenancePending> {
  try {
    return decide(await read());
  } catch {
    return "work";
  }
}

function finish(
  target: AgentDatabaseMigrationTarget,
  conditions: AgentDatabaseMaintenancePlan["conditions"],
): AgentDatabaseMaintenancePlan {
  return {
    agentId: target.agentId,
    path: target.path,
    realPath: target.realPath,
    conditions,
    pending: combineAgentDatabasePending(Object.values(conditions)),
  };
}

function readRegisteredAgentDatabases(env: NodeJS.ProcessEnv) {
  try {
    // Doctor discovery must observe registrations committed by another process.
    invalidateRegisteredAgentDatabasesMemo({ env });
    return listOpenClawRegisteredAgentDatabases({ env, includeIncompatibleSchemaVersions: true });
  } catch {
    return undefined;
  }
}

/** Plan one discovered database. Missing, deleted and incognito stores are undecidable. */
async function planAgentDatabaseMaintenance(
  target: AgentDatabaseMigrationTarget,
  context: {
    env: NodeJS.ProcessEnv;
    integrityCheck?: "quick" | "full";
    prepared?: Pick<
      PreparedAgentDatabaseMigrationDiscovery,
      "versionMigrations" | "preparedTranscriptArchives"
    >;
    registered?: ReturnType<typeof listOpenClawRegisteredAgentDatabases>;
    isSessionEntryStatePrepared?: (target: AgentDatabaseMigrationTarget) => boolean;
  },
): Promise<AgentDatabaseMaintenancePlan> {
  const { env } = context;
  const registered = context.registered ?? readRegisteredAgentDatabases(env);
  const conditions: AgentDatabaseMaintenancePlan["conditions"] = {};
  if (
    agentEngineInput() ||
    isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS) ||
    isArtifactPreservingStateRead("agent", target.path)
  ) {
    conditions.engine = "undecidable";
    return finish(target, conditions);
  }
  conditions.engine = "none";
  if (context.prepared?.versionMigrations?.some((migration) => migration.path === target.path)) {
    // An earlier committed version step defers this database's content repair.
    conditions["schema-version"] = "work";
    return finish(target, conditions);
  }
  conditions["entry-state-preparation"] = decide(
    context.isSessionEntryStatePrepared !== undefined &&
      !context.isSessionEntryStatePrepared(target),
  );
  conditions.quarantine = readCondition(
    () =>
      agentDatabaseLifecycle.terminal.peek(target.path) !== undefined ||
      readOpenClawDatabaseQuarantineFailure("agent", target.path, { env, fresh: true }) !==
        undefined,
  );
  conditions.permissions = readCondition(() =>
    agentDatabasePermissionsNeedRepair(target.path, { agentId: target.agentId, env }),
  );
  conditions.registry =
    registered === undefined
      ? "undecidable"
      : decide(
          !registered.some(
            (entry) =>
              entry.agentId === target.agentId &&
              path.resolve(entry.path) === path.resolve(target.path) &&
              entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION,
          ),
        );

  let opened: ReturnType<typeof openOpenClawAgentDatabaseReadOnly>;
  try {
    opened = openOpenClawAgentDatabaseReadOnly({ agentId: target.agentId, env, path: target.path });
  } catch {
    // Read admission refuses stores that need writable startup admission or are quarantined.
    conditions["schema-version"] = "work";
    return finish(target, conditions);
  }
  if (!opened.found) {
    // Incognito, deleted, missing or ownerless: the reader cannot vouch for this store.
    conditions["schema-version"] = "undecidable";
    return finish(target, conditions);
  }
  const handle = opened.database;
  try {
    // The engine check above leaves only native SQLite handles here.
    // SAFETY: the engine check above returned early for every non-native store.
    const database = handle.db as DatabaseSync;
    let metadata: ReturnType<typeof assertOpenClawAgentDatabaseOwner>;
    try {
      metadata = assertOpenClawAgentDatabaseOwner(database, {
        agentId: target.agentId,
        pathname: target.path,
      });
    } catch {
      conditions["schema-owner"] = "work";
      return finish(target, conditions);
    }
    conditions["schema-owner"] = "none";
    const userVersion = readSqliteUserVersion(database);
    if (userVersion !== OPENCLAW_AGENT_SCHEMA_VERSION || metadata.schemaVersion !== userVersion) {
      // A newer compatible writer owns its own schema; older versions migrate.
      conditions["schema-version"] =
        userVersion > OPENCLAW_AGENT_SCHEMA_VERSION ? "undecidable" : "work";
      return finish(target, conditions);
    }
    conditions["schema-version"] = "none";
    conditions["schema-additive"] = readCondition(
      () =>
        hasPendingCurrentVersionAgentDatabaseMigration(database) ||
        hasPendingSessionKeyContractSchema(database) ||
        hasPendingSessionAdditiveSchema(database),
    );
    conditions["entry-validity"] = readCondition(() => hasPendingSessionEntryValidity(database));
    conditions["schema-metadata"] = readCondition(
      () =>
        !hasCurrentAgentSchemaMetadata(
          database,
          target.agentId,
          OPENCLAW_AGENT_SCHEMA_VERSION,
          metadata.minReader ?? userVersion,
        ),
    );
    conditions["canonical-indexes"] = readCondition(
      () =>
        findCanonicalSqliteIndexDrift(
          OPENCLAW_AGENT_SCHEMA_SQL,
          target.path,
          createSqliteTableContractReader(database),
        ).length > 0,
    );
    conditions["runtime-schema"] = readCondition(() => {
      assertOpenClawAgentCurrentRuntimeSchema(database, {
        agentId: target.agentId,
        pathname: target.path,
      });
      return false;
    });
    conditions["media-rows"] = readCondition(() => !hasMediaRowsMigrationReceipt(database));
    conditions["planner-statistics"] = readCondition(() =>
      sqlitePlannerStatisticsNeedRefresh(database),
    );
    conditions["cold-navigation"] = readCondition(() => hasPendingSessionColdNavigation(database));
    // Archive verification and the integrity check read the whole store. Once a cheaper
    // condition sends this database through the writing pass, that pass reads them itself.
    if (!agentDatabaseMediaPassIsNoop(finish(target, conditions))) {
      return finish(target, conditions);
    }
    const canonicalArchives = new Set<string>();
    conditions["transcript-archives"] = await readAsyncCondition(async () => {
      const verified = await migrateCanonicalTranscriptArchives({
        agentId: target.agentId,
        pathname: target.path,
        database,
        start: { generation: "", sessionId: "" },
        verifyOnly: true,
        verification: {
          key: MEDIA_ARCHIVE_VERIFICATION_KEY,
          prepared: context.prepared?.preparedTranscriptArchives,
        },
        onArchive: (archivePath) => canonicalArchives.add(path.resolve(archivePath)),
        transformLine: transformMediaArchiveContent,
      });
      return verified.pending !== false;
    });
    if (conditions["transcript-archives"] !== "none") {
      return finish(target, conditions);
    }
    conditions["archive-files"] = readCondition(() =>
      listTranscriptArchives(
        resolveSqliteTranscriptArchiveDirectory({ agentId: target.agentId, path: target.path }),
      ).some(
        (archive) =>
          !canonicalArchives.has(path.resolve(archive)) && transcriptArchiveNeedsMigration(archive),
      ),
    );
    if (conditions["archive-files"] !== "none") {
      return finish(target, conditions);
    }
    // Each Doctor run checks the current bytes (#175402). The child reads its own
    // read-only connection; no write transaction surrounds a check that finds nothing.
    conditions.integrity = await readAsyncCondition(async () => {
      const controller = new AbortController();
      await runSqliteIntegrityOperationInWorker(
        sqliteIntegrityCheckSteps(
          database,
          target.path,
          undefined,
          context.integrityCheck
            ? resolveSchemaMigrationIntegrityCheck(
                {
                  kind: "agent",
                  foundVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
                  supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
                },
                context.integrityCheck,
              )
            : {},
        ),
        {
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          signal: resolveSqliteInspectionSignal() ?? controller.signal,
          beforeResume: () => undefined,
        },
      );
      return false;
    });
    return finish(target, conditions);
  } finally {
    handle.close();
  }
}

/**
 * Plan the agent database migration for every discovered database. `isSessionEntryStatePrepared`
 * is the writing pass's own preparation fact; without it, preparation is not a condition.
 */
export async function planAgentDatabaseMigration(params: {
  env: NodeJS.ProcessEnv;
  configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
  preparedDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
  integrityCheck?: "quick" | "full";
  isSessionEntryStatePrepared?: (target: AgentDatabaseMigrationTarget) => boolean;
}): Promise<AgentDatabaseMigrationPlan> {
  // A migration capture or artifact-preserving read serves stores through copies.
  if (storeReadsNeedCopies()) {
    return { discovery: { discovery: "undecidable" }, databases: [], pending: "undecidable" };
  }
  const prepared = prepareAgentDatabaseMigrationDiscovery({
    env: params.env,
    configuredAgentDatabaseTargets: params.configuredAgentDatabaseTargets,
    preparedDiscovery: params.preparedDiscovery,
  });
  const { discovery } = prepared;
  const discoveryConditions: AgentDatabaseMigrationPlan["discovery"] = {
    discovery: decide(
      discovery.deletionJournal.status === "unavailable" ||
        discovery.registryRemovals.length > 0 ||
        discovery.pendingDeletionTargets.length > 0 ||
        discovery.unverifiedTargets.length > 0 ||
        discovery.failures.length > 0 ||
        discovery.warnings.length > 0,
    ),
    "misplaced-copies": readCondition(() => hasMisplacedAgentDatabaseCopies(discovery.targets)),
  };
  const registered = readRegisteredAgentDatabases(params.env);
  const databases: AgentDatabaseMaintenancePlan[] = [];
  const seen = new Set<string>();
  for (const target of discovery.targets) {
    if (seen.has(target.realPath)) {
      continue;
    }
    seen.add(target.realPath);
    databases.push(
      await planAgentDatabaseMaintenance(target, {
        env: params.env,
        integrityCheck: params.integrityCheck,
        prepared,
        registered,
        isSessionEntryStatePrepared: params.isSessionEntryStatePrepared,
      }),
    );
  }
  return {
    discovery: discoveryConditions,
    databases,
    pending: combineAgentDatabasePending([
      ...Object.values(discoveryConditions),
      ...databases.map((database) => database.pending),
    ]),
  };
}

/**
 * The media pass's consumer view of the plan: which discovered databases it may leave
 * untouched, and whether that covers the whole inventory. An unreadable plan leaves
 * every database on the writing pass. Traced as `doctor.agent-database-plan`.
 */
export async function planUnchangedAgentDatabases(
  params: Parameters<typeof planAgentDatabaseMigration>[0] & {
    preparedDiscovery: PreparedAgentDatabaseMigrationDiscovery;
  },
): Promise<{
  all: boolean;
  targets: AgentDatabaseMigrationTarget[];
  has: (target: AgentDatabaseMigrationTarget) => boolean;
}> {
  let plan: AgentDatabaseMigrationPlan | undefined;
  const key = (target: { realPath: string; path: string }) => `${target.realPath}\0${target.path}`;
  const unchanged = await measureGatewayBootstrapStep(
    "doctor.agent-database-plan",
    async () => {
      try {
        plan = await planAgentDatabaseMigration(params);
      } catch {
        resolveSqliteInspectionSignal()?.throwIfAborted();
        return new Set<string>();
      }
      return new Set(plan.databases.filter(agentDatabaseMediaPassIsNoop).map(key));
    },
    () => ({
      pending: plan?.pending ?? "undecidable",
      databases: plan?.databases.length ?? 0,
      unchanged: plan?.databases.filter(agentDatabaseMediaPassIsNoop).length ?? 0,
    }),
  );
  const has = (target: AgentDatabaseMigrationTarget) => unchanged.has(key(target));
  // The pass visits the first locator of each physical database.
  const seen = new Set<string>();
  const targets = params.preparedDiscovery.discovery.targets.filter(
    (target) => !seen.has(target.realPath) && Boolean(seen.add(target.realPath)),
  );
  return {
    all:
      plan !== undefined &&
      combineAgentDatabasePending(Object.values(plan.discovery)) === "none" &&
      params.preparedDiscovery.discovery.targets.every(has),
    targets,
    has,
  };
}
