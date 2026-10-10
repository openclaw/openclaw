// Dedicated quarantine decisions stay available when primary databases fail.
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ExpressionBuilder } from "kysely";
import { hasErrnoCode } from "../infra/errno.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  revokeSqliteDatabaseAdmissionsForPath,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
import {
  parseSqliteFileGeneration,
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
  serializeSqliteFileGeneration,
  type SqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import type { SqliteIntegrityDiagnostics } from "../infra/sqlite-integrity.js";
import { openSqliteReadOnlyDatabase } from "../infra/sqlite-snapshot-source.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { VERSION } from "../version.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import {
  hasRevokedOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  OpenClawQuarantineReadCleanupError,
  type OpenClawDatabaseKind,
  type OpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-error.js";
import { OPENCLAW_DATABASE_SCHEMA_DOCS_URL } from "./openclaw-state-db-contract.js";
import { resolveQuarantineStorePath } from "./openclaw-state-db.paths.js";

const OPENCLAW_QUARANTINE_SCHEMA_VERSION = 2;
const OPENCLAW_QUARANTINE_BUSY_TIMEOUT_MS = 5_000;
const OPENCLAW_QUARANTINE_DIR_MODE = 0o700;
const OPENCLAW_QUARANTINE_FILE_MODE = 0o600;
const quarantineSchemaAdmission: SqliteDatabaseAdmissionKey<{
  version: number;
  integrityTable: boolean;
}> = {
  name: "openclaw.quarantine.schema",
  schemaDependent: true,
  read(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      typeof value.version !== "number" ||
      !("integrityTable" in value) ||
      typeof value.integrityTable !== "boolean"
    ) {
      return undefined;
    }
    return { version: value.version, integrityTable: value.integrityTable };
  },
};

function resolveAgentIntegrityPath(pathname: string): string {
  try {
    return realpathSync.native(pathname);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return path.resolve(pathname);
  }
}

export type OpenClawAgentIntegrityVerification = {
  path: string;
  dev: string;
  ino: string;
  app_version: string;
  verified_at: number;
  clean_close: number;
};
type IntegrityDatabase = { agent_integrity_verifications: OpenClawAgentIntegrityVerification };

export function resolveAgentDatabaseIntegrityGateReason(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  proof: {
    verification?: OpenClawAgentIntegrityVerification;
    validation?: OpenClawAgentDatabaseValidation;
    integrityRevoked: boolean;
    reuseIntegrity: boolean;
  },
): SqliteIntegrityDiagnostics["integrityGateReason"] {
  const { verification, validation, integrityRevoked, reuseIntegrity } = proof;
  if (integrityRevoked) {
    return "stale-lease-full";
  }
  if (hasRevokedOpenClawAgentDatabaseValidation(database.path, validation)) {
    return "revoked";
  }
  if (!reuseIntegrity) {
    return "lease-class";
  }
  return verification?.clean_close === 0 &&
    verification.app_version === VERSION &&
    `${verification.dev}:${verification.ino}` ===
      readOpenClawAgentDatabaseIdentity(database).identity
    ? "dirty-receipt"
    : "no-proof";
}

/** The lease owner consumes this receipt under the shared writer admission. */
export function readOpenClawAgentIntegrityVerification(
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
  consume = false,
): OpenClawAgentIntegrityVerification | undefined {
  const storePath = resolveQuarantineStorePath(env);
  const read = (database: DatabaseSync) => {
    const query = getNodeSqliteKysely<IntegrityDatabase>(database);
    const row = executeSqliteQueryTakeFirstSync(
      database,
      query
        .selectFrom("agent_integrity_verifications")
        .selectAll()
        .where("path", "=", resolveAgentIntegrityPath(pathname)),
    );
    if (consume) {
      const current = statSync(pathname, { bigint: true, throwIfNoEntry: false });
      executeSqliteQuerySync(
        database,
        query
          .updateTable("agent_integrity_verifications")
          .set({ clean_close: 0 })
          .where((eb) =>
            eb.or([
              eb("path", "=", resolveAgentIntegrityPath(pathname)),
              ...(current
                ? [
                    eb.and([
                      eb("dev", "=", String(current.dev)),
                      eb("ino", "=", String(current.ino)),
                    ]),
                  ]
                : []),
            ]),
          ),
      );
    }
    return row;
  };
  if (consume) {
    // Failure cannot admit a writer while leaving an old clean receipt reusable.
    if (statSync(storePath, { throwIfNoEntry: false }) === undefined) {
      return undefined;
    }
    return withQuarantineWriter(env, (database) =>
      runSqliteImmediateTransactionSync(database, () => read(database), {
        databaseLabel: storePath,
        operationLabel: "quarantine.integrity.consume",
      }),
    );
  }
  if (!existsSync(storePath)) {
    return undefined;
  }
  let database: DatabaseSync | undefined;
  try {
    database = openSqliteReadOnlyDatabase(storePath);
    readQuarantineSchemaVersion(database, storePath);
    return read(database);
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

export function canReuseOpenClawAgentIntegrityVerification(
  pathname: string,
  record: OpenClawAgentIntegrityVerification | undefined,
  migrationPending: boolean,
): boolean {
  if (
    migrationPending ||
    !record ||
    record.clean_close !== 1 ||
    record.app_version !== VERSION ||
    record.path !== resolveAgentIntegrityPath(pathname)
  ) {
    return false;
  }
  const current = statSync(pathname, { bigint: true, throwIfNoEntry: false });
  return (
    current !== undefined &&
    record.dev === String(current.dev) &&
    record.ino === String(current.ino)
  );
}

/** Record the lease owner's full check without certifying a clean close. */
export function recordOpenClawAgentIntegrityVerification(
  pathname: string,
  env: NodeJS.ProcessEnv,
  identity: string,
): boolean {
  const current = statSync(pathname, { bigint: true, throwIfNoEntry: false });
  if (!current || identity !== `${current.dev}:${current.ino}`) {
    return false;
  }
  const dev = String(current.dev);
  const ino = String(current.ino);
  withQuarantineWriter(env, (database) => {
    const query = getNodeSqliteKysely<IntegrityDatabase>(database);
    executeSqliteQuerySync(
      database,
      query
        .insertInto("agent_integrity_verifications")
        .values({
          path: resolveAgentIntegrityPath(pathname),
          dev,
          ino,
          app_version: VERSION,
          verified_at: Date.now(),
          clean_close: 0,
        })
        .onConflict((conflict) =>
          conflict.column("path").doUpdateSet({
            dev,
            ino,
            app_version: VERSION,
            verified_at: Date.now(),
            clean_close: 0,
          }),
        ),
    );
  });
  return true;
}

/** Unclean disposal removes the proof that any surviving last closer could certify. */
export function clearOpenClawAgentIntegrityVerification(
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
  runtimeProof: "revoke" | "retain" = "revoke",
): void {
  if (runtimeProof === "revoke") {
    invalidateOpenClawAgentDatabaseValidation(pathname);
  }
  if (statSync(resolveQuarantineStorePath(env), { throwIfNoEntry: false }) === undefined) {
    return;
  }
  withQuarantineWriter(env, (database) =>
    runSqliteImmediateTransactionSync(
      database,
      () => invalidateAgentIntegrityVerification(database, pathname, runtimeProof),
      {
        databaseLabel: resolveQuarantineStorePath(env),
        operationLabel: "quarantine.integrity.invalidate",
      },
    ),
  );
}

function invalidateAgentIntegrityVerification(
  database: DatabaseSync,
  pathname: string,
  runtimeProof: "revoke" | "retain" | "clear-receipt" = "revoke",
): void {
  const query = getNodeSqliteKysely<IntegrityDatabase>(database);
  const stored = executeSqliteQueryTakeFirstSync(
    database,
    query
      .selectFrom("agent_integrity_verifications")
      .select(["dev", "ino"])
      .where("path", "=", resolveAgentIntegrityPath(pathname)),
  );
  const current = statSync(pathname, { bigint: true, throwIfNoEntry: false });
  if (runtimeProof === "revoke") {
    for (const file of [stored, current]) {
      if (file) {
        invalidateOpenClawAgentDatabaseValidation(pathname, `${file.dev}:${file.ino}`);
      }
    }
  }
  const matchesFile = (eb: ExpressionBuilder<IntegrityDatabase, "agent_integrity_verifications">) =>
    eb.or([
      eb("path", "=", resolveAgentIntegrityPath(pathname)),
      ...[stored, current].flatMap((file) =>
        file ? [eb.and([eb("dev", "=", String(file.dev)), eb("ino", "=", String(file.ino))])] : [],
      ),
    ]);
  // A blocked checkpoint dirties restart proof, but a later last writer can
  // still certify this verified file after completing its checkpoint and close.
  if (runtimeProof === "retain") {
    executeSqliteQuerySync(
      database,
      query.updateTable("agent_integrity_verifications").set({ clean_close: 0 }).where(matchesFile),
    );
  } else {
    executeSqliteQuerySync(
      database,
      query.deleteFrom("agent_integrity_verifications").where(matchesFile),
    );
  }
}

/** Only the last graceful lease release may publish cleanliness. */
export function markOpenClawAgentIntegrityClean(
  pathname: string,
  env: NodeJS.ProcessEnv,
  identity: string,
): "written" | "file-changed" | "verification-missing" {
  const current = statSync(pathname, { bigint: true, throwIfNoEntry: false });
  if (!current || identity !== `${current.dev}:${current.ino}`) {
    return "file-changed";
  }
  if (statSync(resolveQuarantineStorePath(env), { throwIfNoEntry: false }) === undefined) {
    return "verification-missing";
  }
  return withQuarantineWriter(env, (database) => {
    const query = getNodeSqliteKysely<IntegrityDatabase>(database);
    const result = executeSqliteQuerySync(
      database,
      query
        .updateTable("agent_integrity_verifications")
        .set({ clean_close: 1 })
        .where("path", "=", resolveAgentIntegrityPath(pathname))
        .where("dev", "=", String(current.dev))
        .where("ino", "=", String(current.ino))
        .where("app_version", "=", VERSION),
    );
    return result.numAffectedRows === 1n ? "written" : "verification-missing";
  });
}

function configureQuarantineWriter(database: DatabaseSync, storePath: string): void {
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
  `);
  const userVersion = readQuarantineSchemaVersion(database, storePath);
  const integrityTable = getSqliteDatabaseAdmission(
    database,
    quarantineSchemaAdmission,
  )?.integrityTable;
  if (userVersion === OPENCLAW_QUARANTINE_SCHEMA_VERSION && integrityTable) {
    return;
  }
  if (userVersion === 1) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE quarantined_databases ADD COLUMN verified_generation TEXT;
      PRAGMA user_version = ${OPENCLAW_QUARANTINE_SCHEMA_VERSION};
      COMMIT;
    `);
  } else if (userVersion !== OPENCLAW_QUARANTINE_SCHEMA_VERSION) {
    database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS quarantined_databases (
      path TEXT NOT NULL PRIMARY KEY,
      kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      quarantined_at INTEGER NOT NULL,
      writer_app_version TEXT,
      verified_generation TEXT
    ) STRICT;
    PRAGMA user_version = ${OPENCLAW_QUARANTINE_SCHEMA_VERSION};
    COMMIT;
    `);
  }
  if (!integrityTable) {
    database.exec(`CREATE TABLE IF NOT EXISTS agent_integrity_verifications (
      path TEXT NOT NULL PRIMARY KEY, dev TEXT NOT NULL, ino TEXT NOT NULL,
      app_version TEXT NOT NULL, verified_at INTEGER NOT NULL,
      clean_close INTEGER NOT NULL CHECK (clean_close IN (0, 1))
    ) STRICT;`);
  }
  publishSqliteDatabaseAdmission(database, quarantineSchemaAdmission, {
    version: OPENCLAW_QUARANTINE_SCHEMA_VERSION,
    integrityTable: true,
  });
}

function readQuarantineSchemaVersion(
  database: DatabaseSync,
  storePath: string,
  fresh = false,
): number {
  const admitted = fresh
    ? undefined
    : getSqliteDatabaseAdmission(database, quarantineSchemaAdmission);
  if (admitted) {
    return admitted.version;
  }
  const row = database.prepare("PRAGMA user_version").get();
  const userVersion = row?.user_version;
  if (typeof userVersion !== "number" || !Number.isInteger(userVersion)) {
    throw new Error(`OpenClaw quarantine store ${storePath} has an invalid schema version.`);
  }
  if (userVersion > OPENCLAW_QUARANTINE_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw quarantine store ${storePath} uses newer schema version ${userVersion}.`,
    );
  }
  if (userVersion !== 0) {
    publishSqliteDatabaseAdmission(database, quarantineSchemaAdmission, {
      version: userVersion,
      integrityTable: false,
    });
  }
  return userVersion;
}

function withQuarantineWriter<T>(env: NodeJS.ProcessEnv, operation: (db: DatabaseSync) => T): T {
  const storePath = resolveQuarantineStorePath(env);
  const existed = existsSync(storePath);
  const dir = path.dirname(storePath);
  mkdirSync(dir, { recursive: true, mode: OPENCLAW_QUARANTINE_DIR_MODE });
  applyPrivateModeSync(dir, OPENCLAW_QUARANTINE_DIR_MODE);
  const database = openNodeSqliteDatabase(storePath, {
    timeout: OPENCLAW_QUARANTINE_BUSY_TIMEOUT_MS,
  });
  let completed = false;
  try {
    if (!existed) {
      applyPrivateModeSync(storePath, OPENCLAW_QUARANTINE_FILE_MODE);
    }
    configureQuarantineWriter(database, storePath);
    const result = operation(database);
    completed = true;
    return result;
  } finally {
    // Failed rollback retires the handle; a second close would mask the write error.
    if (database.isOpen) {
      database.close();
    }
    if (completed || !existed) {
      applyPrivateModeSync(storePath, OPENCLAW_QUARANTINE_FILE_MODE);
    }
  }
}

/** Read one authoritative quarantine decision without creating the store. */
function readOpenClawDatabaseQuarantine(
  pathname: string,
  options: { env?: NodeJS.ProcessEnv; fresh?: true } = {},
): OpenClawDatabaseQuarantine | undefined {
  const storePath = resolveQuarantineStorePath(options.env ?? process.env);
  // Clean installs pay one existence check. No directory or SQLite work.
  if (!existsSync(storePath)) {
    return undefined;
  }
  const database = openSqliteReadOnlyDatabase(storePath, {
    timeout: OPENCLAW_QUARANTINE_BUSY_TIMEOUT_MS,
  });
  let outcome: { value: OpenClawDatabaseQuarantine | undefined } | { error: unknown };
  try {
    outcome = { value: readQuarantineDecision(database, pathname, storePath, options.fresh) };
  } catch (error) {
    outcome = { error };
  }
  try {
    database.close();
  } catch (closeError) {
    throw new OpenClawQuarantineReadCleanupError(
      "error" in outcome ? [outcome.error, closeError] : [closeError],
      "value" in outcome ? outcome.value : undefined,
    );
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

function readQuarantineDecision(
  database: DatabaseSync,
  pathname: string,
  storePath: string,
  fresh = false,
): OpenClawDatabaseQuarantine | undefined {
  const userVersion = readQuarantineSchemaVersion(database, storePath, fresh);
  if (userVersion === 0) {
    return undefined;
  }
  const generationColumn = userVersion >= 2 ? ", verified_generation" : "";
  const row = database
    .prepare(
      `SELECT kind, reason, quarantined_at${generationColumn} FROM quarantined_databases WHERE path = ? LIMIT 1`,
    )
    .get(path.resolve(pathname));
  if (!row) {
    return undefined;
  }
  const verifiedGenerationJson = userVersion >= 2 ? row.verified_generation : undefined;
  if (
    (row.kind !== "agent" && row.kind !== "state") ||
    typeof row.reason !== "string" ||
    typeof row.quarantined_at !== "number" ||
    !Number.isInteger(row.quarantined_at) ||
    (verifiedGenerationJson !== undefined &&
      verifiedGenerationJson !== null &&
      typeof verifiedGenerationJson !== "string")
  ) {
    throw new Error(`OpenClaw quarantine store ${storePath} contains an invalid row.`);
  }
  if (typeof verifiedGenerationJson === "string") {
    let verifiedGeneration: SqliteFileGeneration;
    try {
      verifiedGeneration = parseSqliteFileGeneration(verifiedGenerationJson);
    } catch {
      throw new Error(`OpenClaw quarantine store ${storePath} contains an invalid row.`);
    }
    try {
      const currentGeneration = readStableSqliteFileGeneration(path.resolve(pathname));
      if (!sameSqliteFileGeneration(verifiedGeneration, currentGeneration)) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
  return { kind: row.kind, quarantinedAt: row.quarantined_at, reason: row.reason };
}

/** Runtime opens refuse recorded damage while tolerating a broken quarantine index. */
export function readOpenClawDatabaseQuarantineFailure(
  kind: OpenClawDatabaseKind,
  pathname: string,
  options: { env?: NodeJS.ProcessEnv; fresh?: true } = {},
): Error | undefined {
  let quarantine: OpenClawDatabaseQuarantine | undefined;
  let cleanupFailure: OpenClawQuarantineReadCleanupError | undefined;
  try {
    // A different process can record proven corruption after this process admitted the file.
    quarantine = readOpenClawDatabaseQuarantine(pathname, options);
  } catch (error) {
    if (!(error instanceof OpenClawQuarantineReadCleanupError)) {
      return undefined;
    }
    if (!error.quarantine) {
      throw error;
    }
    quarantine = error.quarantine;
    cleanupFailure = error;
  }
  if (!quarantine) {
    return undefined;
  }
  // Read admission needs this error without importing schema migrations.
  // Doctor's clearing hooks run after a full integrity assertion, so a still-
  // corrupt file cannot be cleared directly: the file must be healthy first.
  const failure = new Error(
    `OpenClaw ${kind} database ${pathname} is quarantined after integrity verification failed: ${quarantine.reason ?? "unknown integrity error"}. Restore the database from a backup or repair it, then run openclaw doctor --fix to clear the quarantine. See ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`,
  );
  failure.name = "SqliteIntegrityError";
  if (cleanupFailure) {
    failure.cause = cleanupFailure;
  }
  return failure;
}

export function recordOpenClawDatabaseQuarantine(options: {
  env?: NodeJS.ProcessEnv;
  generation?: SqliteFileGeneration;
  kind: OpenClawDatabaseKind;
  path: string;
  reason: string;
}): boolean {
  const serializedGeneration = options.generation
    ? serializeSqliteFileGeneration(options.generation)
    : null;
  try {
    const recorded = withQuarantineWriter(options.env ?? process.env, (database) =>
      runSqliteImmediateTransactionSync(
        database,
        () => {
          database
            .prepare(
              `
              INSERT INTO quarantined_databases (
                path, kind, reason, quarantined_at, writer_app_version, verified_generation
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(path) DO UPDATE SET
                kind = excluded.kind,
                reason = excluded.reason,
                quarantined_at = excluded.quarantined_at,
                writer_app_version = excluded.writer_app_version,
                verified_generation = excluded.verified_generation
            `,
            )
            .run(
              path.resolve(options.path),
              options.kind,
              options.reason,
              Date.now(),
              VERSION,
              serializedGeneration,
            );
          if (options.kind === "agent") {
            invalidateAgentIntegrityVerification(database, options.path);
          }
          return true;
        },
        {
          databaseLabel: resolveQuarantineStorePath(options.env ?? process.env),
          operationLabel: "quarantine.record",
        },
      ),
    );
    if (recorded) {
      revokeSqliteDatabaseAdmissionsForPath(options.path);
    }
    return recorded;
  } catch {
    return false;
  }
}

export function clearOpenClawDatabaseQuarantine(
  pathname: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): boolean {
  const env = options.env ?? process.env;
  if (!existsSync(resolveQuarantineStorePath(env))) {
    return true;
  }
  try {
    const cleared = withQuarantineWriter(env, (database) =>
      runSqliteImmediateTransactionSync(
        database,
        () => {
          database
            .prepare("DELETE FROM quarantined_databases WHERE path = ?")
            .run(path.resolve(pathname));
          // The repair owner already published fresh runtime validation; only
          // the old durable clean-close receipt must be discarded here.
          invalidateAgentIntegrityVerification(database, pathname, "clear-receipt");
          return true;
        },
        {
          databaseLabel: resolveQuarantineStorePath(env),
          operationLabel: "quarantine.clear",
        },
      ),
    );
    return cleared;
  } catch {
    return false;
  }
}
