import path from "node:path";
import { formatCliJsonFailure } from "../cli/failure-output.js";
import { exitCliAfterOutput } from "../cli/one-shot-exit.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  preflightOpenClawDatabaseSchemas,
  type OpenClawDatabaseSchemaPreflight,
} from "../state/openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readStateSchemaPublicationBlocker } from "../state/openclaw-state-schema-publication.js";
import { UpdateSchemaRefusalError } from "../state/openclaw-update-schema-refusal.js";
import { VERSION } from "../version.js";

type DrivingUpdater = { version: string; canDeferStateSchema: boolean };

/**
 * The guard reads the driving updater through a private SQLite snapshot. A
 * missing or unreadable run — including snapshot preparation failure — cannot
 * prove the driver writes the ledger and is tolerated (the upgrade proceeds).
 * A snapshot cleanup failure is a real
 * storage problem, but it does not change the schema decision the guard already
 * determined from a successful read, so it is reported as a warning through the
 * runtime output path rather than aborting an otherwise permitted upgrade.
 */
type DrivingUpdaterRead = {
  updater: DrivingUpdater | undefined;
  cleanupWarning: string | undefined;
};

function describeSnapshotCleanupFailure(stagingDir: string, cause: unknown): string {
  const readFailure =
    cause === undefined
      ? ""
      : `${cause instanceof Error ? cause.message : typeof cause === "string" ? cause : JSON.stringify(cause)}; `;
  return `${readFailure}State database snapshot cleanup failed: ${stagingDir}. Check directory permissions and available storage before retrying.`;
}

async function readDrivingUpdater(): Promise<DrivingUpdaterRead> {
  let snapshot: Awaited<ReturnType<typeof prepareSqliteReadOnlyLocation>>;
  try {
    // The runtime ledger reader consults quarantine state. This diagnostic must
    // not open any live database, including a quarantine store needing recovery.
    snapshot = await prepareSqliteReadOnlyLocation(resolveOpenClawStateSqlitePath(), {
      preserveSourceArtifacts: true,
    });
  } catch {
    // A missing or unreadable source, staging failure, or worker read error
    // cannot prove the driver writes the ledger; the guard tolerates it and
    // proceeds without an updater, matching the pre-fix boundary.
    return { updater: undefined, cleanupWarning: undefined };
  }
  let outcome: { value: DrivingUpdater | undefined } | { cause: unknown };
  try {
    const database = openNodeSqliteDatabase(snapshot.location, { readOnly: true });
    try {
      const blocker = readStateSchemaPublicationBlocker(database);
      outcome = blocker
        ? {
            value: {
              version: blocker.updaterVersion,
              canDeferStateSchema: tableExists(database, "config_machine_state"),
            },
          }
        : { value: undefined };
    } finally {
      clearNodeSqliteKyselyCacheForDatabase(database);
      database.close();
    }
  } catch (cause) {
    outcome = { cause };
  }
  // The exit retry is best-effort, not proof that this private copy was removed.
  // A cleanup failure is reported as a warning but does not replace the schema
  // decision already determined from a successful read.
  const cleanupWarning = snapshot.cleanup()
    ? undefined
    : describeSnapshotCleanupFailure(
        path.dirname(snapshot.location),
        "cause" in outcome ? outcome.cause : undefined,
      );
  if ("cause" in outcome) {
    // A missing or unreadable run cannot prove the driver writes the ledger;
    // the guard tolerates the read failure and proceeds without an updater.
    return { updater: undefined, cleanupWarning };
  }
  return { updater: outcome.value, cleanupWarning };
}

/** Refuse before CLI capture or Doctor maintenance can open writable state. */
export async function guardUpdateDoctorSchemaUpgrade(options: {
  schemas?: OpenClawDatabaseSchemaPreflight;
  runtime: RuntimeEnv;
  json?: boolean;
}): Promise<void> {
  if (process.env.OPENCLAW_UPDATE_IN_PROGRESS !== "1") {
    return;
  }
  const schemas =
    options.schemas ??
    (await preflightOpenClawDatabaseSchemas({
      env: process.env,
      supportedVersions: {
        state: OPENCLAW_STATE_SCHEMA_VERSION,
        agent: OPENCLAW_AGENT_SCHEMA_VERSION,
      },
    }));
  if (!schemas.pendingMigrations?.length) {
    return;
  }
  // Read failures are tolerated (no proof of a driving updater); a cleanup
  // failure is surfaced as a warning without aborting the upgrade.
  const { updater, cleanupWarning } = await readDrivingUpdater();
  if (cleanupWarning) {
    // In JSON mode the guard runs before console capture is installed, so
    // runtime.log (console.log → stdout) would prefix the JSON output and
    // make it unparseable. Write directly to stderr instead.
    if (options.json) {
      process.stderr.write(`${cleanupWarning}\n`);
    } else {
      options.runtime.log(cleanupWarning);
    }
  }
  if (!updater) {
    return;
  }
  const blockedMigrations = schemas.pendingMigrations.filter(
    (database) => database.kind === "agent" || !updater.canDeferStateSchema,
  );
  if (blockedMigrations.length === 0) {
    return;
  }
  const error = new UpdateSchemaRefusalError(blockedMigrations, updater.version, {
    targetVersion: VERSION,
  });
  if (options.json) {
    writeRuntimeJson(options.runtime, formatCliJsonFailure(error));
    exitCliAfterOutput(options.runtime, 1);
  }
  throw error;
}
