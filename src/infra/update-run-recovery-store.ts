import { isDeepStrictEqual } from "node:util";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  readPluginCohortArtifactIdentity,
  readPluginCohortArtifactPreimage,
  readPluginCohortRetentionMarker,
} from "../plugins/update-cohort-artifacts.js";
import {
  updateConfigMachineStateInDatabase,
  writeConfigMachineStateInDatabase,
} from "../state/config-machine-state-write.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { getOpenClawStateFeatureSchemaSql } from "../state/openclaw-state-feature-schema.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { EngineConnection } from "./sql-connection.js";
import {
  assertPluginCohortRecoveryBinding,
  decodePluginCohortRecovery,
  encodePluginCohortRecovery,
  PLUGIN_COHORT_RECOVERY_KEY_END,
  PLUGIN_COHORT_RECOVERY_KEY_PREFIX,
  type PluginCohortRecovery,
  type PluginCohortRecoveryBinding,
  type PluginCohortRecoveryPair,
  type PluginCohortMigrationPublication,
  type PluginCohortRecoveryWriteBinding,
} from "./update-plugin-cohort-schema.js";
import { withUpdateRunRead } from "./update-run-read-admission.js";
import { UPDATE_RECOVERY_KEY_END, UPDATE_RECOVERY_KEY_PREFIX } from "./update-run-recovery-keys.js";
import {
  decodeUpdateRecovery,
  inspectUpdateRecovery,
  type UpdateRecoveryInspection,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import type { UpdateRecoveryFence } from "./update-run-recovery-types.js";

type RecoveryDatabase = Pick<DB, "update_runs" | "config_machine_state">;

function readRecoveryRows(db: EngineConnection, runId?: string) {
  if (!tableExists(db, "config_machine_state")) {
    return [];
  }
  const query = getNodeSqliteKysely<RecoveryDatabase>(db)
    .selectFrom("config_machine_state")
    .select(["state_key", "value_json"]);
  return executeSqliteQuerySync(
    db,
    runId === undefined
      ? query
          .where("state_key", ">=", UPDATE_RECOVERY_KEY_PREFIX)
          .where("state_key", "<", UPDATE_RECOVERY_KEY_END)
          .orderBy("state_key", "asc")
      : query.where("state_key", "=", UPDATE_RECOVERY_KEY_PREFIX + runId),
  ).rows;
}
/** Execution reads only its named operation; unrelated history is not execution input. */
export function readRecovery(
  db: EngineConnection,
  runId: string,
): UpdateRecoveryRecord | undefined {
  const row = readRecoveryRows(db, runId)[0];
  return row ? decodeUpdateRecovery(row.value_json, runId) : undefined;
}

export function inspectRecoveryRows(db: EngineConnection): UpdateRecoveryInspection[] {
  return readRecoveryRows(db).map(({ value_json, state_key }) =>
    inspectUpdateRecovery(value_json, state_key.slice(UPDATE_RECOVERY_KEY_PREFIX.length)),
  );
}
/** Private read-only compatibility surface for diagnostics and retained-pair
 * inspection. Legacy receipts remain exact historical evidence, never authority.
 * Execution loaders below deliberately reject them instead of upgrading them. */
export function inspectUpdateRecoveries(
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryInspection[] {
  return withUpdateRunRead(({ db }) => inspectRecoveryRows(db), options) ?? [];
}

type RecoveryPairRow = { state_key: string; value_json: string; updated_at_ms: number };
const cohortStorageSchema = getOpenClawStateFeatureSchemaSql("config_machine_state");

function readPluginCohortPairRows(db: EngineConnection, runId: string): RecoveryPairRow[] {
  if (!tableExists(db, "config_machine_state")) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<RecoveryDatabase>(db)
      .selectFrom("config_machine_state")
      .select(["state_key", "value_json", "updated_at_ms"])
      .where("state_key", "in", [
        UPDATE_RECOVERY_KEY_PREFIX + runId,
        PLUGIN_COHORT_RECOVERY_KEY_PREFIX + runId,
      ]),
  ).rows;
}

function decodePluginCohortPair(
  rows: ReadonlyArray<{ state_key: string; value_json: string }>,
  runId: string,
): PluginCohortRecoveryPair {
  const reservation = rows.find((row) => row.state_key === UPDATE_RECOVERY_KEY_PREFIX + runId);
  const cohort = rows.find((row) => row.state_key === PLUGIN_COHORT_RECOVERY_KEY_PREFIX + runId);
  if (!reservation || !cohort) {
    throw new Error("Plugin cohort recovery is missing its matching reservation");
  }
  const pair = {
    reservation: decodeUpdateRecovery(reservation.value_json, runId),
    cohort: decodePluginCohortRecovery(cohort.value_json, runId),
  };
  assertPluginCohortRecoveryBinding(pair);
  return pair;
}

/** Validate raw rows before a database owner preserves their exact serialized bytes. */
export function decodePluginCohortRecoveryPairRows(
  rows: ReadonlyArray<{ state_key: string; value_json: string }>,
  expected: PluginCohortRecoveryBinding,
): PluginCohortRecoveryPair | undefined {
  if (rows.length === 0) {
    return undefined;
  }
  const pair = decodePluginCohortPair(rows, expected.runId);
  if (rows.length !== 2 || pair.cohort.transactionId !== expected.transactionId) {
    throw new Error("Plugin cohort recovery transaction changed");
  }
  return pair;
}

/** Restore carries only this exact pair; unrelated machine state belongs to the baseline. */
export function readPluginCohortRecoveryPairRows(
  db: EngineConnection,
  expected: PluginCohortRecoveryBinding,
): RecoveryPairRow[] {
  const rows = readPluginCohortPairRows(db, expected.runId);
  decodePluginCohortRecoveryPairRows(rows, expected);
  return rows;
}

export function loadPluginCohortRecovery(
  runId: string,
  options: OpenClawStateDatabaseOptions & { allowNativeRead?: true } = {},
): PluginCohortRecoveryPair | undefined {
  return withUpdateRunRead(({ db }) => readPluginCohortRecoveryInDatabase(db, runId), options);
}

export function readPluginCohortRecoveryInDatabase(
  db: EngineConnection,
  runId: string,
): PluginCohortRecoveryPair | undefined {
  const rows = readPluginCohortPairRows(db, runId);
  // A reservation without this companion remains the existing full-state owner's responsibility.
  return rows.some((row) => row.state_key === PLUGIN_COHORT_RECOVERY_KEY_PREFIX + runId)
    ? decodePluginCohortPair(rows, runId)
    : undefined;
}

export function inspectPluginCohortRecoveries(
  options: OpenClawStateDatabaseOptions = {},
): PluginCohortRecoveryPair[] {
  return withUpdateRunRead(({ db }) => inspectPluginCohortRecoveryRows(db), options) ?? [];
}

/** Runtime consumers retain the existing read worker and its selected database admission. */
export async function inspectPluginCohortRecoveriesAsync(
  options: OpenClawStateDatabaseOptions = {},
): Promise<PluginCohortRecoveryPair[]> {
  const { executeExistingOpenClawStateRead } =
    await import("../state/openclaw-state-db-readonly.js");
  const result = await executeExistingOpenClawStateRead(
    options,
    { type: "updateRuns.pluginCohortRecoveries" },
    { current: true },
  );
  return result?.pairs ?? [];
}

export function inspectPluginCohortRecoveryRows(db: EngineConnection): PluginCohortRecoveryPair[] {
  if (!tableExists(db, "config_machine_state")) {
    return [];
  }
  const rows = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<RecoveryDatabase>(db)
      .selectFrom("config_machine_state")
      .select("state_key")
      .where("state_key", ">=", PLUGIN_COHORT_RECOVERY_KEY_PREFIX)
      .where("state_key", "<", PLUGIN_COHORT_RECOVERY_KEY_END)
      .orderBy("state_key", "asc"),
  ).rows;
  return rows.map((row) => {
    const runId = row.state_key.slice(PLUGIN_COHORT_RECOVERY_KEY_PREFIX.length);
    return decodePluginCohortPair(readPluginCohortPairRows(db, runId), runId);
  });
}

function withPluginCohortRecoveryWrite<T>(
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions,
  operation: (db: EngineConnection) => T,
): T {
  fence.assertCurrent();
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      fence.assertCurrent();
      const result = operation(db);
      fence.assertCurrent();
      return result;
    },
    options,
    { schemaSql: cohortStorageSchema, operationLabel: "update.plugin-cohort" },
  );
}

export function beginPluginCohortRecovery(
  reservation: UpdateRecoveryRecord,
  cohort: PluginCohortRecovery,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): PluginCohortRecoveryPair {
  const pair = {
    reservation: decodeUpdateRecovery(JSON.stringify(reservation), reservation.runId),
    cohort: decodePluginCohortRecovery(encodePluginCohortRecovery(cohort), cohort.runId),
  };
  assertPluginCohortRecoveryBinding(pair);
  if (pair.cohort.revision !== 0) {
    throw new Error("Plugin cohort recovery must begin at revision zero");
  }
  return withPluginCohortRecoveryWrite(fence, options, (db) => {
    if (readPluginCohortPairRows(db, cohort.runId).length !== 0) {
      throw new Error("Plugin cohort recovery already exists");
    }
    writeConfigMachineStateInDatabase(
      db,
      UPDATE_RECOVERY_KEY_PREFIX + cohort.runId,
      pair.reservation,
    );
    writeConfigMachineStateInDatabase(
      db,
      PLUGIN_COHORT_RECOVERY_KEY_PREFIX + cohort.runId,
      pair.cohort,
    );
    return pair;
  });
}

function assertCurrentPluginCohortPair(db: EngineConnection, expected: PluginCohortRecoveryPair) {
  const rows = readPluginCohortRecoveryPairRows(db, expected.cohort);
  if (rows.length === 0) {
    return false;
  }
  if (!isDeepStrictEqual(decodePluginCohortPair(rows, expected.cohort.runId), expected)) {
    throw new Error("Plugin cohort recovery changed before settlement");
  }
  return true;
}

export function writePluginCohortRecovery(
  previousPair: PluginCohortRecoveryPair,
  nextCohort: PluginCohortRecovery,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): PluginCohortRecoveryPair {
  const cohort = decodePluginCohortRecovery(
    encodePluginCohortRecovery({ ...nextCohort, revision: previousPair.cohort.revision + 1 }),
    previousPair.cohort.runId,
  );
  const pair = { reservation: previousPair.reservation, cohort };
  assertPluginCohortRecoveryBinding(pair);
  return withPluginCohortRecoveryWrite(fence, options, (db) => {
    if (!assertCurrentPluginCohortPair(db, previousPair)) {
      throw new Error("Plugin cohort recovery changed before settlement");
    }
    writeConfigMachineStateInDatabase(db, PLUGIN_COHORT_RECOVERY_KEY_PREFIX + cohort.runId, cohort);
    return pair;
  });
}

export function deletePluginCohortRecovery(
  expectedPair: PluginCohortRecoveryPair,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): void {
  withPluginCohortRecoveryWrite(fence, options, (db) => {
    // A committed deletion can lose its acknowledgement; repeating it has no effects.
    if (!assertCurrentPluginCohortPair(db, expectedPair)) {
      return;
    }
    const now = Date.now();
    for (const prefix of [UPDATE_RECOVERY_KEY_PREFIX, PLUGIN_COHORT_RECOVERY_KEY_PREFIX]) {
      updateConfigMachineStateInDatabase(
        db,
        prefix + expectedPair.cohort.runId,
        () => undefined,
        now,
      );
    }
  });
}

/** The installed-index owner records its actual delta in the same leased transaction. */
export function recordPluginCohortIndexPublicationInDatabase(
  db: EngineConnection,
  binding: Pick<PluginCohortRecovery, "runId" | "transactionId" | "installKey">,
  before: Record<string, PluginInstallRecord>,
  after: Record<string, PluginInstallRecord>,
): void {
  const pair = decodePluginCohortPair(readPluginCohortPairRows(db, binding.runId), binding.runId);
  if (
    pair.cohort.transactionId !== binding.transactionId ||
    pair.cohort.installKey !== binding.installKey
  ) {
    throw new Error("Plugin index publication belongs to a different update cohort");
  }
  if (pair.cohort.disposition !== "pending") {
    return;
  }
  const records = [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(
    (pluginId) =>
      isDeepStrictEqual(before[pluginId], after[pluginId]) ||
      (before[pluginId]?.source !== "npm" && after[pluginId]?.source !== "npm")
        ? []
        : [{ pluginId, before: before[pluginId], after: after[pluginId] }],
  );
  if (records.length === 0) {
    return;
  }
  const priorArtifacts = [...pair.cohort.priorArtifacts];
  for (const change of records) {
    const record = change.before;
    if (
      record?.source !== "npm" ||
      !record.installPath ||
      priorArtifacts.some(
        (artifact) =>
          artifact.packageDir === record.installPath && isDeepStrictEqual(artifact.record, record),
      )
    ) {
      continue;
    }
    const identity = readPluginCohortArtifactPreimage(record.installPath);
    priorArtifacts.push({
      pluginId: change.pluginId,
      packageDir: record.installPath,
      record,
      identity,
      markerBefore:
        identity === null
          ? null
          : readPluginCohortRetentionMarker(record.installPath, {
              OPENCLAW_STATE_DIR: pair.reservation.source!.stateDir,
            }),
      markerAfter: null,
    });
  }
  const artifacts = pair.cohort.artifacts.map((artifact) => {
    if (
      artifact.identity ||
      !records.some((change) => change.after?.installPath === artifact.targetPackageDir)
    ) {
      return artifact;
    }
    return { ...artifact, identity: readPluginCohortArtifactIdentity(artifact.targetPackageDir) };
  });
  const cohort = {
    ...pair.cohort,
    priorArtifacts,
    artifacts,
    revision: pair.cohort.revision + 1,
    publications: [...pair.cohort.publications, { kind: "records" as const, records }],
  };
  encodePluginCohortRecovery(cohort);
  writeConfigMachineStateInDatabase(db, PLUGIN_COHORT_RECOVERY_KEY_PREFIX + binding.runId, cohort);
}

/** The obligation owner appends only its exact rows in the same existing transaction. */
export function recordPluginCohortMigrationPublicationInDatabase(
  db: EngineConnection,
  binding: PluginCohortRecoveryWriteBinding,
  publication: PluginCohortMigrationPublication,
): void {
  const pair = decodePluginCohortPair(readPluginCohortPairRows(db, binding.runId), binding.runId);
  if (
    pair.cohort.transactionId !== binding.transactionId ||
    pair.cohort.installKey !== binding.installKey
  ) {
    throw new Error("Plugin migration publication belongs to a different update cohort");
  }
  if (pair.cohort.disposition !== "pending" || publication.rows.length === 0) {
    return;
  }
  const cohort = {
    ...pair.cohort,
    revision: pair.cohort.revision + 1,
    publications: [...pair.cohort.publications, publication],
  };
  encodePluginCohortRecovery(cohort);
  writeConfigMachineStateInDatabase(db, PLUGIN_COHORT_RECOVERY_KEY_PREFIX + binding.runId, cohort);
}
