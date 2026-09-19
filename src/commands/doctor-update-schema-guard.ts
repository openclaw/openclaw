import { formatCliJsonFailure } from "../cli/failure-output.js";
import { exitCliAfterOutput } from "../cli/one-shot-exit.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readStateSchemaPublicationBlocker } from "../state/openclaw-state-schema-publication.js";
import { UpdateSchemaRefusalError } from "../state/openclaw-update-schema-refusal.js";
import { VERSION } from "../version.js";
import {
  prepareDoctorDatabasePreflight,
  type DoctorDatabasePreflight,
} from "./doctor-database-preflight.js";
import {
  recordUpdateDoctorRefusal,
  resolveUpdateDoctorGitRecovery,
} from "./doctor-update-refusal.js";

async function readDrivingUpdater(): Promise<
  { version: string; canDeferStateSchema: boolean } | undefined
> {
  // The runtime ledger reader consults quarantine state. This diagnostic must
  // not open any live database, including a quarantine store needing recovery.
  const snapshot = await prepareSqliteReadOnlyLocation(resolveOpenClawStateSqlitePath(), {
    preserveSourceArtifacts: true,
  });
  try {
    const database = openNodeSqliteDatabase(snapshot.location, { readOnly: true });
    let closeSchemaReadAdmission: (() => void) | undefined;
    try {
      closeSchemaReadAdmission = openDoctorStateSchemaReadAdmission(database);
      const blocker = readStateSchemaPublicationBlocker(database);
      return blocker
        ? {
            version: blocker.updaterVersion,
            canDeferStateSchema: tableExists(database, "config_machine_state"),
          }
        : undefined;
    } finally {
      try {
        closeSchemaReadAdmission?.();
      } finally {
        clearNodeSqliteKyselyCacheForDatabase(database);
        database.close();
      }
    }
  } finally {
    await snapshot.cleanupAsync();
  }
}

/** Prepare reusable fleet facts and refuse before CLI bootstrap or Doctor can write state. */
export async function guardUpdateDoctorSchemaUpgrade(options: {
  schemas?: DoctorDatabasePreflight;
  runtime?: RuntimeEnv;
  json?: boolean;
}): Promise<DoctorDatabasePreflight | undefined> {
  if (process.env.OPENCLAW_UPDATE_IN_PROGRESS !== "1") {
    return undefined;
  }
  const schemas = options.schemas ?? (await prepareDoctorDatabasePreflight());
  if (!schemas.pendingMigrations?.length) {
    return schemas;
  }
  let updater: Awaited<ReturnType<typeof readDrivingUpdater>>;
  try {
    updater = await readDrivingUpdater();
  } catch {
    // A missing or unreadable run cannot prove that the driver writes the ledger.
  }
  if (!updater) {
    return schemas;
  }
  const blockedMigrations = schemas.pendingMigrations.filter(
    (database) => database.kind === "agent" || !updater.canDeferStateSchema,
  );
  if (blockedMigrations.length === 0) {
    return schemas;
  }
  const recovery = await resolveUpdateDoctorGitRecovery();
  const error = new UpdateSchemaRefusalError(blockedMigrations, updater.version, {
    targetVersion: VERSION,
    recovery,
  });
  if (recovery) {
    recordUpdateDoctorRefusal(error.message);
  }
  if (options.json) {
    const runtime = options.runtime ?? defaultRuntime;
    writeRuntimeJson(runtime, formatCliJsonFailure(error));
    exitCliAfterOutput(runtime, 1);
  }
  throw error;
}
