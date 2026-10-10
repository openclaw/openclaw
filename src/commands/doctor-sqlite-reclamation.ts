import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "../infra/disk-space.js";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { readFiniteSqliteNumber } from "../infra/sqlite-number.js";
import type { AgentDatabaseMigrationTarget } from "../infra/state-migrations.media-persistence-targets.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { invalidateOpenClawAgentDatabaseIntegrityBeforeMutation } from "../state/openclaw-agent-db-lease.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db-maintenance.js";
import { assertOpenClawStateDatabaseForMaintenance } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowed } from "../state/openclaw-state-ownership.js";
import {
  compactDoctorSqliteFile,
  DoctorSqliteCompactionDeferredError,
} from "./doctor-sqlite-compact.js";
import { assertDoctorSqliteMaintenancePathsNotAliased } from "./doctor-sqlite-maintenance-lock.js";

class ReclamationDeferred extends Error {}

function pragmaNumber(database: DatabaseSync, name: "auto_vacuum" | "page_count" | "page_size") {
  const value = readFiniteSqliteNumber(database.prepare(`PRAGMA ${name}`).get()?.[name]);
  if (value === undefined || value < 0) {
    throw new Error(`SQLite PRAGMA ${name} returned an invalid result.`);
  }
  return value;
}

/** VACUUM may place its temporary database on a different volume from its WAL. */
function assertVacuumSpace(sqlitePath: string, bytes: number, env: NodeJS.ProcessEnv) {
  const databaseDirectory = path.dirname(sqlitePath);
  // node:sqlite does not expose SQLITE_FCNTL_TEMPFILENAME. Unix SQLite caches
  // environment choices at initialization; Windows uses native temp APIs.
  // Check possible volumes conservatively rather than guessing the selected one.
  const candidates = new Set([
    databaseDirectory,
    ...[env.SQLITE_TMPDIR, env.TMPDIR, env.TMP, env.TEMP, os.tmpdir()].filter(
      (candidate): candidate is string => Boolean(candidate?.trim()),
    ),
    ...(process.platform === "win32" ? [] : ["/var/tmp", "/usr/tmp", "/tmp", process.cwd()]),
  ]);
  const devices = new Set<bigint>();
  // SQLite documents up to twice the original database size for VACUUM's
  // temporary database and rollback journal/WAL. Keep the updater's metadata allowance.
  const required = bytes * 2 + 64 * 1024 * 1024;
  for (const candidate of candidates) {
    let stat: fs.BigIntStats;
    try {
      stat = fs.statSync(candidate, { bigint: true });
      if (!stat.isDirectory()) {
        continue;
      }
      fs.accessSync(candidate, fs.constants.W_OK | fs.constants.X_OK);
    } catch (cause) {
      if (candidate === databaseDirectory) {
        throw new ReclamationDeferred("the database directory is not writable", { cause });
      }
      continue;
    }
    if (stat.dev > 0n && devices.has(stat.dev)) {
      continue;
    }
    const space = tryReadDiskSpace(candidate);
    if (!space || space.availableBytes < required) {
      throw new ReclamationDeferred(
        `${formatDiskSpaceBytes(required)} of temporary space is needed near ${candidate}; ${space ? `${formatDiskSpaceBytes(space.availableBytes)} available` : "free space could not be measured"}`,
      );
    }
    devices.add(stat.dev);
  }
  if (devices.size === 0) {
    throw new ReclamationDeferred("database and SQLite temporary storage could not be verified");
  }
}

/** The existing Doctor owner calls this only after its readers and writers have drained. */
export async function enableDoctorSqliteReclamation(params: {
  env: NodeJS.ProcessEnv;
  agents: readonly AgentDatabaseMigrationTarget[];
  signal: AbortSignal;
  assertCurrent: () => void;
  log: (message: string) => void;
}): Promise<{ warnings: string[] }> {
  const sharedPath = resolveOpenClawStateSqlitePath(params.env);
  const targets = [
    { path: sharedPath, agentId: undefined },
    ...params.agents.map((agent) => ({ path: agent.path, agentId: agent.agentId })),
  ];
  const warnings: string[] = [];
  const visited = new Set<string>();
  const assertAdmission = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  for (const target of targets) {
    // Native SQLite is synchronous. Deliver signals queued during the previous
    // operation before admitting another file, without interrupting an admitted VACUUM.
    await setImmediate();
    assertAdmission();
    const sqlitePath = path.resolve(target.path);
    if (visited.has(sqlitePath)) {
      continue;
    }
    visited.add(sqlitePath);
    const identity = fs.lstatSync(sqlitePath, { bigint: true, throwIfNoEntry: false });
    if (!identity) {
      continue;
    }
    const assertIdentity = () => {
      const current = fs.lstatSync(sqlitePath, { bigint: true, throwIfNoEntry: false });
      if (!current?.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new ReclamationDeferred("the database file identity changed");
      }
      try {
        assertDoctorSqliteMaintenancePathsNotAliased(
          "automatic SQLite reclamation",
          resolveSqliteDatabaseFilePaths(sqlitePath),
          [path.parse(sqlitePath).root],
        );
      } catch (cause) {
        throw new ReclamationDeferred(formatErrorMessage(cause), { cause });
      }
    };
    const validate = (database: DatabaseSync) => {
      assertAdmission();
      assertIdentity();
      if (target.agentId === undefined) {
        assertOpenClawStateWriteAllowed({ database, databasePath: sqlitePath, env: params.env });
        assertOpenClawStateDatabaseForMaintenance(database, { pathname: sqlitePath });
      } else {
        assertOpenClawAgentDatabaseForMaintenance(database, {
          pathname: sqlitePath,
          agentId: target.agentId,
        });
      }
    };
    let admitted = false;
    let verified = false;
    try {
      assertIdentity();
      // A real read-only SQLite connection sees the current mode through WAL;
      // reading only the main-file header can mistake an already-converted store.
      const database = openNodeSqliteDatabase(sqlitePath, { readOnly: true });
      let requiresConversion = false;
      try {
        requiresConversion = pragmaNumber(database, "auto_vacuum") === 0;
        if (requiresConversion) {
          validate(database);
          const bytes = Math.max(
            Number(identity.size),
            pragmaNumber(database, "page_count") * pragmaNumber(database, "page_size"),
          );
          assertVacuumSpace(sqlitePath, bytes, params.env);
        }
      } finally {
        database.close();
      }
      assertAdmission();
      assertIdentity();
      if (!requiresConversion) {
        continue;
      }
      if (target.agentId !== undefined) {
        invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(sqlitePath, params.env);
      }
      params.log(`Enabling incremental SQLite reclamation once: ${sqlitePath}`);
      const result = compactDoctorSqliteFile({
        sqlitePath,
        requireExisting: true,
        busyTimeoutMs: 0,
        validateBeforeMutation(writable) {
          validate(writable);
          admitted = true;
        },
        afterSuccess: assertIdentity,
      });
      if (result.after.autoVacuum !== 2) {
        throw new Error("SQLite compaction did not enable incremental reclamation.");
      }
      verified = true;
      params.assertCurrent();
      params.log(
        `Enabled incremental SQLite reclamation: ${sqlitePath}; reclaimed ${formatDiskSpaceBytes(result.reclaimedBytes)}; integrity verified.`,
      );
    } catch (error) {
      if (admitted && !verified && !(error instanceof DoctorSqliteCompactionDeferredError)) {
        let cause = error;
        try {
          assertAdmission();
        } catch (admissionError) {
          cause = new AggregateError(
            [error, admissionError],
            "SQLite reclamation failed during interruption.",
          );
        }
        throw new DoctorMaintenanceRefusalError(
          `SQLite reclamation did not finish verified for ${sqlitePath}: ${formatErrorMessage(error)}. Inspect this database before restarting the Gateway.`,
          { kind: "data-at-risk", reason: "incomplete-migration" },
          { cause },
        );
      }
      assertAdmission();
      if (
        !(error instanceof ReclamationDeferred) &&
        !(error instanceof DoctorSqliteCompactionDeferredError)
      ) {
        throw error;
      }
      const command =
        target.agentId === undefined
          ? "openclaw doctor --state-sqlite compact"
          : "openclaw doctor --session-sqlite compact --session-sqlite-all-agents";
      warnings.push(
        `Automatic SQLite reclamation deferred for ${sqlitePath}: ${error.message}. The update can continue; after resolving this condition, run ${command} while the Gateway is stopped.`,
      );
    }
  }
  await setImmediate();
  assertAdmission();
  return { warnings };
}
