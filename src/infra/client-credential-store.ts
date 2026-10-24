import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { inspectDarwinAcl } from "@openclaw/fs-safe/permissions";
import { resolveStateDir } from "../config/paths.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { openRootFileSync } from "./boundary-file-read.js";
import {
  performClientCredentialOperation,
  type ClientCredentialOperation,
  type ClientCredentialResult,
} from "./client-credential-operations.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import {
  admitClientCredentialStore,
  assertMissingClientCredentialStoreReady,
  readClientCredentialAdmission,
} from "./client-credential-readiness.js";
import {
  CLIENT_CREDENTIAL_SCHEMA_SQL,
  CLIENT_CREDENTIAL_SCHEMA_VERSION,
} from "./client-credential-schema.js";
import { hasErrnoCode } from "./errno.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { preparePrivateStoreFileSync } from "./private-store-file.js";
import {
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "./sqlite-database-admission.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { assertSqliteSchemaContains } from "./sqlite-schema-contract.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { readSqliteUserVersion, writeSqliteUserVersion } from "./sqlite-user-version.js";
import { readDatabaseIdentityBirthtime, resolveDatabasePathKey } from "./sqlite-worker-identity.js";
import { runUpdateSqliteMigration } from "./update-doctor-migration-attribution.js";
export type {
  ClientTokenRecord,
  ClientSocketRecord,
  ClientTokenKey,
  ClientCredentialOperation,
  ClientCredentialResult,
} from "./client-credential-operations.js";

const retainedPaths = resolveGlobalSingleton(
  Symbol.for("openclaw.clientCredentialCustody"),
  () => new Set<string>(),
);
const admittedFiles = resolveGlobalSingleton(
  Symbol.for("openclaw.clientCredentialAdmittedFiles"),
  () => new Map<string, { identity: string; version: number }>(),
  (files) => files.clear(),
);
class ClientCredentialBusyError extends Error {
  constructor() {
    super("Client credential owner is busy.");
    this.name = "ClientCredentialBusyError";
  }
}
export function isClientCredentialBusyError(error: unknown): boolean {
  return error instanceof ClientCredentialBusyError || isSqliteLockError(error);
}

const schemaAdmission: SqliteDatabaseAdmissionKey<true> = {
  name: "client.credentials.schema-v1",
  schemaDependent: true,
  read: (value) => (value === true ? true : undefined),
};

function assertPrivateAcl(pathname: string): void {
  if (process.platform === "darwin" && inspectDarwinAcl(pathname).kind !== "none") {
    throw new Error("Client credentials require a private directory and file without ACL entries.");
  }
}

export type ClientCredentialCustody = {
  database: DatabaseSync;
  path: string;
  created: boolean;
  needsMetadataUpgrade: boolean;
  transaction<T>(operation: () => T): T;
  run(operation: ClientCredentialOperation, beforeCommit?: () => void): ClientCredentialResult;
  close(): void;
  [Symbol.dispose](): void;
};

/** One admitted handle retains SQLite exclusion across individual commits. */
export function openClientCredentialCustody(
  env: NodeJS.ProcessEnv,
  options: {
    createIfMissing?: boolean;
    readOnly?: boolean;
    migration?: boolean;
    timeoutMs?: number;
  } = {},
  execute?: (database: DatabaseSync) => void,
): ClientCredentialCustody | undefined {
  const createIfMissing = (options.createIfMissing ?? false) && !options.readOnly;
  const pathname = resolveClientCredentialStorePath(env);
  const directory = path.dirname(pathname);
  const custodyKey = resolveDatabasePathKey(pathname);
  if (retainedPaths.has(custodyKey)) {
    throw new ClientCredentialBusyError();
  }
  if (options.migration) {
    admittedFiles.delete(custodyKey);
  }
  if (!options.migration && !fs.existsSync(pathname)) {
    assertMissingClientCredentialStoreReady(env);
  }
  const parent = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    parent &&
    (!parent.isDirectory() ||
      (process.getuid && parent.uid !== process.getuid()) ||
      (process.platform !== "win32" && (parent.mode & 0o077) !== 0))
  ) {
    throw new Error("Client credential directory is unsafe.");
  }
  if (!parent && !createIfMissing) {
    return undefined;
  }
  if (parent) {
    assertPrivateAcl(directory);
  }
  let created = false;
  if (createIfMissing) {
    created = preparePrivateStoreFileSync(pathname, Boolean(parent));
  }
  const opened = openRootFileSync({
    absolutePath: pathname,
    rootPath: directory,
    boundaryLabel: "client credential store",
    rejectSymlinks: true,
  });
  if (!opened.ok) {
    if (hasErrnoCode(opened.error, "ENOENT") && !createIfMissing) {
      return undefined;
    }
    throw new Error("Client credential store cannot be safely opened.", { cause: opened.error });
  }
  retainedPaths.add(custodyKey);
  let db: DatabaseSync | undefined;
  let closed = false;
  let physicalClose: (() => void) | undefined;
  try {
    const stat = fs.fstatSync(opened.fd, { bigint: true });
    if (
      (process.getuid && stat.uid !== BigInt(process.getuid())) ||
      (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n)
    ) {
      throw new Error("Client credential store owner is unsafe.");
    }
    const identity = `${stat.dev}:${stat.ino}:${readDatabaseIdentityBirthtime(stat)}`;
    assertPrivateAcl(pathname);
    db = openNodeSqliteDatabase(resolveExistingSqliteFileUri(pathname), {
      timeout: options.timeoutMs ?? 5000,
    });
    const database = db;
    if (
      // sqlite-allow-raw -- Read native journal policy before admission.
      db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete"
    ) {
      throw new Error(
        "Client credentials require DELETE journal mode for exclusive owner custody.",
      );
    }
    physicalClose = () => {
      if (!closed) {
        closed = true;
        try {
          database.close();
        } finally {
          fs.closeSync(opened.fd);
          retainedPaths.delete(custodyKey);
        }
      }
    };
    const transaction = <T>(operation: () => T): T => {
      if (closed) {
        throw new Error("Client credential custody is closed.");
      }
      if (options.readOnly) {
        return runSqliteImmediateTransactionSync(database, operation);
      }
      return runUpdateSqliteMigration(
        database,
        pathname,
        () => runSqliteImmediateTransactionSync(database, operation),
        { retainExclusive: true },
      );
    };
    const cached = admittedFiles.get(custodyKey);
    let initialized = false;
    let needsMetadataUpgrade = false;
    transaction(() => {
      // Acquire custody before retaining locks so competing openers can release their shared locks.
      database.exec("PRAGMA locking_mode=EXCLUSIVE"); // sqlite-allow-raw -- Retain owner custody across operation commits.
      if (
        options.migration ||
        cached?.identity !== identity ||
        cached.version !== CLIENT_CREDENTIAL_SCHEMA_VERSION
      ) {
        const version = readSqliteUserVersion(database);
        if (
          version === 0 &&
          !database.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get() // sqlite-allow-raw -- Bootstrap only an empty native catalog.
        ) {
          if (!createIfMissing) {
            throw new Error("Client credential store is empty; run openclaw doctor --fix.");
          }
          database.exec(CLIENT_CREDENTIAL_SCHEMA_SQL); // sqlite-allow-raw -- Canonical first-use schema DDL.
          initialized = true;
          writeSqliteUserVersion(database, CLIENT_CREDENTIAL_SCHEMA_VERSION);
        } else {
          if (version !== CLIENT_CREDENTIAL_SCHEMA_VERSION) {
            throw new Error(
              `Client credentials have unsupported schema version ${String(version)}. Use a compatible OpenClaw version.`,
            );
          }
          assertSqliteSchemaContains(database, "Client credentials", CLIENT_CREDENTIAL_SCHEMA_SQL);
          assertSqliteIntegrity(database, "Client credentials");
        }
        publishSqliteDatabaseAdmission(database, schemaAdmission, true);
      }
      if (!options.migration) {
        const admission = readClientCredentialAdmission(database);
        const receipt = admitClientCredentialStore(database, env, {
          initialize: initialized,
          readOnly: options.readOnly ?? false,
          stored: admission.stored,
        });
        needsMetadataUpgrade = receipt.sharedFile !== null && receipt.source === null;
      }
      // Bounded callers join admission and row work in this same exclusive transaction.
      if (!initialized) {
        execute?.(database);
      }
    });
    // First-use schema creation survives cancellation of the caller's row write.
    if (initialized && execute) {
      transaction(() => execute(database));
    }
    if (!options.migration) {
      admittedFiles.set(custodyKey, { identity, version: CLIENT_CREDENTIAL_SCHEMA_VERSION });
    }
    return {
      database,
      path: pathname,
      created,
      needsMetadataUpgrade,
      transaction,
      run(operation, beforeCommit) {
        if (closed) {
          throw new Error("Client credential custody is closed.");
        }
        if (options.readOnly && isClientCredentialMutation(operation)) {
          throw new Error("Client credential custody is read-only.");
        }
        const run = () => {
          const result = performClientCredentialOperation(
            database,
            operation,
            resolveStateDir(env),
          );
          beforeCommit?.();
          return result;
        };
        return transaction(run);
      },
      close: physicalClose,
      [Symbol.dispose]: physicalClose,
    };
  } catch (error) {
    admittedFiles.delete(custodyKey);
    if (physicalClose) {
      physicalClose();
    } else {
      db?.close();
      fs.closeSync(opened.fd);
      retainedPaths.delete(custodyKey);
    }
    throw error;
  }
}

function clientCredentialOperationCreatesStore(operation: ClientCredentialOperation): boolean {
  return ["identity.create", "identity.repair", "token.replace", "socket.ensure"].includes(
    operation.kind,
  );
}

export function isClientCredentialMutation(operation: ClientCredentialOperation): boolean {
  return !["identity.read", "token.read", "token.list", "socket.read"].includes(operation.kind);
}

export function runClientCredentialOperation(
  env: NodeJS.ProcessEnv,
  operation: ClientCredentialOperation,
  options: { beforeCommit?: () => void; readOnly?: boolean } = {},
): ClientCredentialResult {
  if (options.readOnly && isClientCredentialMutation(operation)) {
    throw new Error("Client credential custody is read-only.");
  }
  let result!: ClientCredentialResult;
  using owner = openClientCredentialCustody(
    env,
    {
      createIfMissing: clientCredentialOperationCreatesStore(operation),
      readOnly: options.readOnly,
    },
    (database) => {
      result = performClientCredentialOperation(database, operation, resolveStateDir(env));
      options.beforeCommit?.();
    },
  );
  return owner ? result : missingClientCredentialResult(env, operation);
}

/** A noncreating lookup can settle without opening any database. */
function missingClientCredentialResult(
  env: NodeJS.ProcessEnv,
  operation: ClientCredentialOperation,
): ClientCredentialResult {
  assertMissingClientCredentialStoreReady(env);
  switch (operation.kind) {
    case "identity.read":
      return { kind: "identity", identity: null };
    case "token.read":
      return { kind: "token", token: null };
    case "token.list":
      return { kind: "tokens", tokens: [], nextRole: null };
    case "socket.read":
      return { kind: "socket", socket: null };
    case "native.tokens.clear":
      return { kind: "cleared", count: 0 };
    default:
      return { kind: "changed", changed: false };
  }
}
