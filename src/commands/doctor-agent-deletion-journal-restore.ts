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

function readVerifiedOwner(database: DatabaseSync, agentId: string) {
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
  return row;
}

function inspectOwner(pathname: string, agentId: string) {
  const snapshot = prepareSqliteReadOnlyLocationSync(pathname);
  let producer: ReturnType<typeof readVerifiedOwner>;
  let cleanedUp: boolean;
  try {
    using database = openNodeSqliteDatabase(snapshot.location, { readOnly: true });
    producer = readVerifiedOwner(database, agentId);
  } finally {
    cleanedUp = snapshot.cleanup();
  }
  if (!cleanedUp) {
    throw new Error(`Could not release agent recovery inspection snapshot: ${snapshot.location}`);
  }
  return producer;
}

/** Restore configured, verified stores after journal loss; quarantine still needs explicit consent. */
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
      const producer = inspectOwner(target.path, target.agentId);
      return producer ? [{ ...target, producer }] : [];
    } catch (error) {
      warnings.push(
        `Agent ${target.agentId} remains held; could not verify its database ownership: ${formatErrorMessage(error)}`,
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
  // Configured ownership and missing-table provenance permit restoration, even after
  // an upgrade changed the producer stamp. Preserve a verified rollback group first.
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
              isDeepStrictEqual(readVerifiedOwner(database, target.agentId), target.producer),
          )
        ) {
          throw new Error(
            "Recovery backup does not preserve the verified agent ownership metadata.",
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
        if (!isDeepStrictEqual(inspectOwner(target.path, agentId), target.producer)) {
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
        `Warning: Automatically restored agent ${agentId} database ${target.path}${isReservedSystemAgentId(agentId) ? " after verifying reserved system-agent ownership" : " after verifying configured ownership and missing deletion history"}. Verified backup: ${backupPaths.find((entry) => samePath(entry.sourcePath, target.path))!.path}; shared state and reconstruction records: ${sharedBackup.path}.`,
      );
    }
  }
  return { changes, warnings, restored };
}
