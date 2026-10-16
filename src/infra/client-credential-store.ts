import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createDirectorySync, createFileSync } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { inspectDarwinAcl } from "@openclaw/fs-safe/permissions";
import { resolveStateDir } from "../config/paths.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { openRootFileSync } from "./boundary-file-read.js";
import {
  performClientCredentialOperation,
  type ClientCredentialOperation,
  type ClientCredentialResult,
} from "./client-credential-operations.js";
import {
  admitClientCredentialStore,
  assertMissingClientCredentialStoreReady,
} from "./client-credential-readiness.js";
import {
  CLIENT_CREDENTIAL_SCHEMA_SQL,
  CLIENT_CREDENTIAL_SCHEMA_VERSION,
} from "./client-credential-schema.js";
import { hasErrnoCode } from "./errno.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { applyPrivateModeSync } from "./private-mode.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "./sqlite-database-admission.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { assertSqliteSchemaContains } from "./sqlite-schema-contract.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { readSqliteUserVersion, writeSqliteUserVersion } from "./sqlite-user-version.js";
import { resolveDatabasePathKey } from "./sqlite-worker-identity.js";
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

export function resolveClientCredentialStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "client", "credentials.sqlite");
}

function createPrivateIfMissing(create: () => void): void {
  try {
    create();
  } catch (error) {
    if (!(error instanceof FsSafeError && error.code === "already-exists")) {
      throw error;
    }
  }
}

function assertPrivateAcl(pathname: string): void {
  if (process.platform === "darwin" && inspectDarwinAcl(pathname).kind !== "none") {
    throw new Error("Client credentials require a private directory and file without ACL entries.");
  }
}

export type ClientCredentialCustody = {
  database: DatabaseSync;
  path: string;
  created: boolean;
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
): ClientCredentialCustody | undefined {
  const createIfMissing = (options.createIfMissing ?? false) && !options.readOnly;
  const pathname = resolveClientCredentialStorePath(env);
  const directory = path.dirname(pathname);
  const custodyKey = resolveDatabasePathKey(pathname);
  if (retainedPaths.has(custodyKey)) {
    throw new ClientCredentialBusyError();
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
    if (!parent) {
      fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
      createPrivateIfMissing(() => createDirectorySync(directory, { private: true }));
    }
    applyPrivateModeSync(directory, 0o700);
    if (!fs.existsSync(pathname)) {
      createPrivateIfMissing(() => {
        createFileSync(pathname, { private: true }).close();
        created = true;
      });
    }
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
    const stat = fs.fstatSync(opened.fd);
    if (
      (process.getuid && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error("Client credential store owner is unsafe.");
    }
    assertPrivateAcl(pathname);
    db = openNodeSqliteDatabase(resolveExistingSqliteFileUri(pathname), {
      timeout: options.timeoutMs ?? 5000,
    });
    const database = db;
    // Admission retains SQLite exclusion for this bounded handle's lifetime,
    // including between operation commits.
    db.exec("PRAGMA locking_mode=EXCLUSIVE"); // sqlite-allow-raw -- Connection-local exclusive owner custody.
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
    let initialized = false;
    runSqliteImmediateTransactionSync(database, () => {
      if (!getSqliteDatabaseAdmission(database, schemaAdmission)) {
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
        admitClientCredentialStore(database, env, {
          initialize: initialized,
          readOnly: options.readOnly ?? false,
        });
      }
    });
    return {
      database,
      path: pathname,
      created,
      run(operation, beforeCommit) {
        if (closed) {
          throw new Error("Client credential custody is closed.");
        }
        if (options.readOnly && isClientCredentialMutation(operation)) {
          throw new Error("Client credential custody is read-only.");
        }
        return runSqliteImmediateTransactionSync(database, () => {
          const result = performClientCredentialOperation(
            database,
            operation,
            resolveStateDir(env),
          );
          beforeCommit?.();
          return result;
        });
      },
      close: physicalClose,
      [Symbol.dispose]: physicalClose,
    };
  } catch (error) {
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

export function clientCredentialOperationCreatesStore(
  operation: ClientCredentialOperation,
): boolean {
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
  options: { timeoutMs?: number; beforeCommit?: () => void; readOnly?: boolean } = {},
): ClientCredentialResult {
  if (options.readOnly && isClientCredentialMutation(operation)) {
    throw new Error("Client credential custody is read-only.");
  }
  using owner = openClientCredentialCustody(env, {
    createIfMissing: clientCredentialOperationCreatesStore(operation),
    timeoutMs: options.timeoutMs,
    readOnly: options.readOnly,
  });
  if (owner) {
    return owner.run(operation, options.beforeCommit);
  }
  return missingClientCredentialResult(env, operation);
}

/** A noncreating lookup can settle without opening any database. */
export function missingClientCredentialResult(
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
