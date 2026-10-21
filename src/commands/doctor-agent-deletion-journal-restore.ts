import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { createConfigIO } from "../config/io.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { prepareSqliteReadOnlyLocationSync } from "../infra/sqlite-snapshot-source.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { resolveAgentDeletionRecoveryHolds } from "../state/agent-deletion-journal-recovery.js";
import {
  readAgentDeletionMissingJournalHolds,
  readAgentDeletionRecoveryHolds,
  type RecoveryDatabase,
} from "../state/agent-deletion-journal-recovery.kernel.js";
import { readAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import type { HeldAgentDatabase } from "../state/agent-deletion-journal.types.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { isStatePostgres } from "../state/openclaw-state-db-engine.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { backupDoctorSqliteDatabases } from "./doctor-migration-backup.js";

// Integrity-verified published artifacts, including all three published channels.
const AFFECTED_AGENT_SCHEMAS = new Map<string, number>([
  ...[
    "2026.9.7",
    "2026.9.8",
    "2026.9.9",
    "2026.9.33",
    "2026.10.1-beta.1",
    "2026.10.1-beta.2",
    "2026.10.1",
    "2026.10.2",
    "2026.10.3",
    "2026.10.4",
  ].map((version) => [version, 24] as const),
  ...["2026.10.5-beta.1", "2026.10.5-beta.2", "2026.10.5-beta.3", "2026.10.5-beta.4"].map(
    (version) => [version, 25] as const,
  ),
  ["2026.10.10-beta.1", 27],
]);

function readAffectedProducer(database: DatabaseSync, agentId: string) {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<Pick<DB, "schema_meta">>(database)
      .selectFrom("schema_meta")
      .selectAll()
      .where("meta_key", "=", "primary"),
  );
  if (
    row?.role !== "agent" ||
    row.agent_id !== agentId ||
    readSqliteUserVersion(database) !== row.schema_version
  ) {
    return undefined;
  }
  // System stores have no legitimate deletion history. Ordinary agents need
  // the affected producer's unchanged birth stamp to restore lost deletion intent.
  return isReservedSystemAgentId(agentId) ||
    (row.app_version !== null &&
      AFFECTED_AGENT_SCHEMAS.get(row.app_version) === row.schema_version &&
      row.created_at > 0 &&
      row.created_at === row.updated_at)
    ? row
    : undefined;
}

function inspectProducer(pathname: string, agentId: string) {
  const snapshot = prepareSqliteReadOnlyLocationSync(pathname);
  let producer: ReturnType<typeof readAffectedProducer>;
  let cleanedUp: boolean;
  try {
    using database = openNodeSqliteDatabase(snapshot.location, { readOnly: true });
    producer = readAffectedProducer(database, agentId);
  } finally {
    cleanedUp = snapshot.cleanup();
  }
  if (!cleanedUp) {
    throw new Error(`Could not release agent recovery inspection snapshot: ${snapshot.location}`);
  }
  return producer;
}

/** Reconcile invalid system holds and the published native-first missing-journal cohort. */
export async function restoreDoctorMissingJournalStores(params: {
  env: NodeJS.ProcessEnv;
  held: readonly HeldAgentDatabase[];
}): Promise<{ changes: string[]; warnings: string[]; restored: HeldAgentDatabase[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const restored: HeldAgentDatabase[] = [];
  if (params.held.length === 0 || isStatePostgres()) {
    return { changes, warnings, restored };
  }
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    return { changes, warnings, restored };
  }
  const snapshot = await createConfigIO({
    env: params.env,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  if (!snapshot.valid) {
    return { changes, warnings, restored };
  }
  const samePath = createOpenClawAgentDatabasePathMatcher();
  const configured = resolveConfiguredAgentDatabaseTargets(snapshot.sourceConfig, {
    env: params.env,
    registeredDatabases: params.held,
  });
  const agentIds = listAgentIds(snapshot.sourceConfig);
  const readEligibleHolds = (database: RecoveryDatabase, agentId: string) =>
    isReservedSystemAgentId(agentId)
      ? readAgentDeletionRecoveryHolds(database)
      : readAgentDeletionMissingJournalHolds(database);
  const matchesReceipt = (target: HeldAgentDatabase, current?: RecoveryDatabase) => {
    const matches = (database: RecoveryDatabase) =>
      readEligibleHolds(database, target.agentId).some(
        (entry) => entry.agentId === target.agentId && samePath(entry.path, target.path),
      ) && !readAgentDeletionJournalInDatabase(database, target.agentId);
    return current
      ? matches(current)
      : withExistingOpenClawStateDatabaseCurrentReadOnly(matches, {
          env: params.env,
          allowNativeRead: true,
        }) === true;
  };
  const eligible = params.held.flatMap((target) => {
    const owned = isReservedSystemAgentId(target.agentId)
      ? samePath(
          target.path,
          resolveOpenClawAgentSqlitePath({ agentId: target.agentId, env: params.env }),
        )
      : agentIds.includes(target.agentId) &&
        configured.some(
          (entry) => entry.agentId === target.agentId && samePath(entry.path, target.path),
        );
    if (!owned || !matchesReceipt(target)) {
      return [];
    }
    try {
      const producer = inspectProducer(target.path, target.agentId);
      return producer ? [{ ...target, producer }] : [];
    } catch (error) {
      warnings.push(
        `Agent ${target.agentId} remains held; could not verify its original producer: ${formatErrorMessage(error)}`,
      );
      return [];
    }
  });
  if (eligible.length === 0) {
    return { changes, warnings, restored };
  }
  const remaining = new Set(eligible);
  const assertCurrent = (database?: RecoveryDatabase) => {
    maintenance.assertAdmission();
    if (
      !samePath.isCurrent() ||
      [...remaining].some((target) => !matchesReceipt(target, database))
    ) {
      throw new Error(
        "Agent deletion recovery changed; preserved stores remain held. Rerun Doctor.",
      );
    }
  };
  assertCurrent();
  // Ordinary agents require the published missing-journal cohort; reserved agents
  // cannot be deleted. Both repairs preserve a verified rollback group first.
  const backups = await backupDoctorSqliteDatabases({
    env: params.env,
    pendingDatabasePaths: eligible.map((target) => target.path),
    databasePaths: eligible.map((target) => target.path),
    authority: { assertCurrent },
    requireSnapshots: true,
    repair: {
      key: "published-missing-agent-deletion-journal",
      validate: (database) => {
        const owner = executeSqliteQueryTakeFirstSync(
          database,
          getNodeSqliteKysely<Pick<DB, "schema_meta">>(database)
            .selectFrom("schema_meta")
            .select(["role", "agent_id"])
            .where("meta_key", "=", "primary"),
        );
        if (owner?.role === "global") {
          const source = { db: database, path: resolveOpenClawStateSqlitePath(params.env) };
          if (
            eligible.some(
              (target) =>
                !readEligibleHolds(source, target.agentId).some(
                  (entry) => entry.agentId === target.agentId && samePath(entry.path, target.path),
                ) || readAgentDeletionJournalInDatabase(source, target.agentId),
            )
          ) {
            throw new Error(
              "Recovery backup does not preserve the deletion reconstruction records.",
            );
          }
        } else if (
          !eligible.some(
            (target) =>
              target.agentId === owner?.agent_id &&
              isDeepStrictEqual(readAffectedProducer(database, target.agentId), target.producer),
          )
        ) {
          throw new Error(
            "Recovery backup does not preserve the affected agent producer metadata.",
          );
        }
      },
    },
  });
  changes.push(...backups.changes);
  warnings.push(...backups.warnings);
  const backupPaths = backups.snapshots ?? [];
  const sharedBackup = backupPaths.find((entry) =>
    samePath(entry.sourcePath, resolveOpenClawStateSqlitePath(params.env)),
  );
  if (!sharedBackup) {
    throw new Error(
      "Agent restoration requires a verified shared-state and reconstruction-record backup.",
    );
  }
  const { createAgent } = await import("../agents/agent-create.js");
  let expectedConfigHash = snapshot.hash ?? null;
  for (const agentId of new Set(eligible.map((target) => target.agentId))) {
    const targets = eligible.filter((target) => target.agentId === agentId);
    assertCurrent();
    if (isReservedSystemAgentId(agentId)) {
      for (const target of targets) {
        if (!isDeepStrictEqual(inspectProducer(target.path, agentId), target.producer)) {
          throw new Error(`System agent ${agentId} ownership changed before recovery.`);
        }
      }
      runOpenClawStateWriteTransaction(
        (database) => {
          assertCurrent(database);
          resolveAgentDeletionRecoveryHolds(
            database,
            agentId,
            targets.map((target) => target.path),
          );
        },
        { env: params.env },
      );
    } else {
      const result = await createAgent({
        name: agentId,
        expectedConfigHash,
        restorePaths: targets.map((target) => target.path),
        beforePersistentApply: assertCurrent,
      });
      if (result.status === "error") {
        warnings.push(`Agent ${agentId} remains held: ${result.message}`);
        continue;
      }
      expectedConfigHash = result.configHash ?? expectedConfigHash;
    }
    // Check the selected owner actually resolved each hold before reporting recovery.
    for (const target of targets) {
      const stillHeld = withExistingOpenClawStateDatabaseCurrentReadOnly(
        (database) =>
          readAgentDeletionRecoveryHolds(database).some(
            (entry) => entry.agentId === target.agentId && samePath(entry.path, target.path),
          ),
        { env: params.env, allowNativeRead: true },
      );
      if (stillHeld !== false) {
        throw new Error(`Agent ${agentId} restoration left ${target.path} held.`);
      }
      remaining.delete(target);
      restored.push(target);
      warnings.push(
        `Warning: Automatically restored agent ${agentId} database ${target.path}${isReservedSystemAgentId(agentId) ? " after verifying reserved system-agent ownership" : ` created by affected OpenClaw ${target.producer.app_version}`}. Verified backup: ${backupPaths.find((entry) => samePath(entry.sourcePath, target.path))!.path}; shared state and reconstruction records: ${sharedBackup.path}.`,
      );
    }
  }
  return { changes, warnings, restored };
}
