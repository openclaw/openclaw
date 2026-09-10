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

/**
 * Marks a snapshot cleanup failure so the guard can distinguish it from an
 * unreadable driving updater. A missing or unreadable run cannot prove the
 * driver writes the ledger and is tolerated; a cleanup failure is a real
 * storage problem that must surface to the operator, not be swallowed.
 */
class DoctorSchemaSnapshotCleanupError extends Error {
  constructor(stagingDir: string, cause: unknown) {
    const readFailure =
      cause === undefined ? "" : `${cause instanceof Error ? cause.message : String(cause)}; `;
    super(
      `${readFailure}State database snapshot cleanup failed: ${stagingDir}. Check directory permissions and available storage before retrying.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "DoctorSchemaSnapshotCleanupError";
  }
}

async function readDrivingUpdater(): Promise<
  { version: string; canDeferStateSchema: boolean } | undefined
> {
  // The runtime ledger reader consults quarantine state. This diagnostic must
  // not open any live database, including a quarantine store needing recovery.
  const snapshot = await prepareSqliteReadOnlyLocation(resolveOpenClawStateSqlitePath(), {
    preserveSourceArtifacts: true,
  });
  let outcome:
    | { value: { version: string; canDeferStateSchema: boolean } | undefined }
    | {
        cause: unknown;
      };
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
  if (!snapshot.cleanup()) {
    throw new DoctorSchemaSnapshotCleanupError(
      path.dirname(snapshot.location),
      "cause" in outcome ? outcome.cause : undefined,
    );
  }
  if ("cause" in outcome) {
    throw outcome.cause;
  }
  return outcome.value;
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
  let updater: Awaited<ReturnType<typeof readDrivingUpdater>>;
  try {
    updater = await readDrivingUpdater();
  } catch (error) {
    // A missing or unreadable run cannot prove that the driver writes the ledger,
    // so read failures are tolerated. A snapshot cleanup failure is a real storage
    // problem and must surface rather than silently let the upgrade proceed.
    if (error instanceof DoctorSchemaSnapshotCleanupError) {
      throw error;
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
