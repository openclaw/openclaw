import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createDirectorySync, createFileSync } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { inspectDarwinAcl } from "@openclaw/fs-safe/permissions";
import { expressionBuilder } from "kysely";
import { resolveStateDir } from "../config/paths.js";
import { openRootFileSync } from "./boundary-file-read.js";
import {
  CLIENT_CREDENTIAL_SCHEMA_SQL,
  CLIENT_CREDENTIAL_SCHEMA_VERSION,
  type ClientCredentialDatabase,
} from "./client-credential-schema.js";
import { hasErrnoCode } from "./errno.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { applyPrivateModeSync } from "./private-mode.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "./sqlite-database-admission.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { assertSqliteSchemaContains } from "./sqlite-schema-contract.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { readSqliteUserVersion, writeSqliteUserVersion } from "./sqlite-user-version.js";

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

/**
 * Offline adapter for one bounded owner operation. A running native owner must
 * be used through its local operations instead. Its exclusive SQLite handle
 * prevents an unavailable IPC endpoint from becoming a second writer.
 * This preparatory store is not wired into credential consumers until cutover.
 */
export function withClientCredentialStore<T>(
  env: NodeJS.ProcessEnv,
  createIfMissing: boolean,
  operation: (db: DatabaseSync) => T,
): T | undefined {
  const pathname = resolveClientCredentialStorePath(env);
  const directory = path.dirname(pathname);
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
  if (createIfMissing) {
    if (!parent) {
      fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
      createPrivateIfMissing(() => createDirectorySync(directory, { private: true }));
    }
    applyPrivateModeSync(directory, 0o700);
    if (!fs.existsSync(pathname)) {
      createPrivateIfMissing(() => createFileSync(pathname, { private: true }).close());
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
  try {
    const stat = fs.fstatSync(opened.fd);
    if (
      (process.getuid && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error("Client credential store owner is unsafe.");
    }
    assertPrivateAcl(pathname);
    using db = openNodeSqliteDatabase(resolveExistingSqliteFileUri(pathname), { timeout: 5000 });
    // The app keeps this same SQLite lock across its bounded operations. CLI
    // custody ends at close; no PID, timestamp, or second lock database decides it.
    db.exec("PRAGMA locking_mode=EXCLUSIVE"); // sqlite-allow-raw -- Connection-local exclusive owner custody.
    if (
      // sqlite-allow-raw -- Read native journal policy before admission.
      db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete"
    ) {
      throw new Error(
        "Client credentials require DELETE journal mode for exclusive owner custody.",
      );
    }
    return runSqliteImmediateTransactionSync(db, () => {
      if (!getSqliteDatabaseAdmission(db, schemaAdmission)) {
        const version = readSqliteUserVersion(db);
        if (
          version === 0 &&
          !db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get() // sqlite-allow-raw -- Bootstrap only an empty native catalog.
        ) {
          if (!createIfMissing) {
            return undefined;
          }
          db.exec(CLIENT_CREDENTIAL_SCHEMA_SQL); // sqlite-allow-raw -- Canonical first-use schema DDL.
          writeSqliteUserVersion(db, CLIENT_CREDENTIAL_SCHEMA_VERSION);
        } else {
          if (version !== CLIENT_CREDENTIAL_SCHEMA_VERSION) {
            throw new Error(
              `Client credentials have unsupported schema version ${String(version)}. Use a compatible OpenClaw version.`,
            );
          }
          assertSqliteSchemaContains(db, "Client credentials", CLIENT_CREDENTIAL_SCHEMA_SQL);
          assertSqliteIntegrity(db, "Client credentials");
        }
        publishSqliteDatabaseAdmission(db, schemaAdmission, true);
      }
      return operation(db);
    });
  } finally {
    fs.closeSync(opened.fd);
  }
}

export type ClientIdentityRecord = ClientCredentialDatabase["device_identities"];
export type ClientTokenRecord = ClientCredentialDatabase["device_auth_tokens"];
export type ClientSocketRecord = ClientCredentialDatabase["native_exec_socket_credentials"];
export type ClientTokenKey = Pick<ClientTokenRecord, "device_id" | "role"> & {
  gateway_scope?: string;
};

/** Typed owner operations; IPC decoding belongs at its local transport boundary. */
export type ClientCredentialOperation =
  | { kind: "identity.read"; identity_key: string }
  | { kind: "identity.create"; identity: ClientIdentityRecord }
  | { kind: "token.read"; key: ClientTokenKey }
  | {
      kind: "token.replace";
      key: ClientTokenKey;
      token: ClientTokenRecord;
      expectedToken: string | null;
    }
  | { kind: "token.remove"; key: ClientTokenKey; expectedToken: string }
  | { kind: "socket.read" }
  | { kind: "socket.create"; socket: ClientSocketRecord }
  | { kind: "socket.replace"; socket: ClientSocketRecord; expectedToken: string | null };

export type ClientCredentialResult =
  | { kind: "identity"; identity: ClientIdentityRecord | null }
  | { kind: "token"; token: ClientTokenRecord | null }
  | { kind: "changed"; changed: boolean }
  | { kind: "socket"; socket: ClientSocketRecord | null };

/**
 * Executes under the local store's exclusive custody. Production callers are
 * installed together in the later cutover; this release only prepares the owner.
 */
export function runClientCredentialOperation(
  env: NodeJS.ProcessEnv,
  operation: ClientCredentialOperation,
): ClientCredentialResult {
  const create =
    operation.kind === "identity.create" ||
    operation.kind === "token.replace" ||
    operation.kind === "socket.create" ||
    operation.kind === "socket.replace";
  const result = withClientCredentialStore(env, create, (database): ClientCredentialResult => {
    const db = getNodeSqliteKysely<ClientCredentialDatabase>(database);
    switch (operation.kind) {
      case "identity.read":
      case "identity.create": {
        if (operation.kind === "identity.create") {
          const inserted = executeSqliteQuerySync(
            database,
            db
              .insertInto("device_identities")
              .values(operation.identity)
              .onConflict((conflict) => conflict.column("identity_key").doNothing()),
          );
          if (inserted.numAffectedRows === 1n) {
            return { kind: "identity", identity: operation.identity };
          }
        }
        const key =
          operation.kind === "identity.read"
            ? operation.identity_key
            : operation.identity.identity_key;
        return {
          kind: "identity",
          identity:
            executeSqliteQueryTakeFirstSync(
              database,
              db.selectFrom("device_identities").selectAll().where("identity_key", "=", key),
            ) ?? null,
        };
      }
      case "token.read":
      case "token.replace":
      case "token.remove": {
        const { key } = operation;
        const table =
          key.gateway_scope === undefined ? "device_auth_tokens" : "gateway_origin_device_tokens";
        // Keep the two key spaces distinct; role strings already carry their native scope.
        const eb = expressionBuilder<
          ClientCredentialDatabase,
          "device_auth_tokens" | "gateway_origin_device_tokens"
        >();
        const matchKey = eb.and([
          eb("device_id", "=", key.device_id),
          eb("role", "=", key.role),
          ...(key.gateway_scope === undefined ? [] : [eb("gateway_scope", "=", key.gateway_scope)]),
        ]);
        const match = db.selectFrom(table).selectAll().where(matchKey);
        if (operation.kind === "token.read") {
          const row = executeSqliteQueryTakeFirstSync(database, match);
          return {
            kind: "token",
            token: row
              ? {
                  device_id: row.device_id,
                  role: row.role,
                  token: row.token,
                  scopes_json: row.scopes_json,
                  updated_at_ms: row.updated_at_ms,
                }
              : null,
          };
        }
        const current = executeSqliteQueryTakeFirstSync(database, match);
        if ((current?.token ?? null) !== operation.expectedToken) {
          return { kind: "changed", changed: false };
        }
        if (operation.kind === "token.remove") {
          if (!current) {
            return { kind: "changed", changed: false };
          }
          executeSqliteQuerySync(database, db.deleteFrom(table).where(matchKey));
        } else {
          const values = { ...operation.token, device_id: key.device_id, role: key.role };
          if (key.gateway_scope === undefined) {
            executeSqliteQuerySync(
              database,
              db
                .insertInto("device_auth_tokens")
                .values(values)
                .onConflict((conflict) =>
                  conflict.columns(["device_id", "role"]).doUpdateSet(values),
                ),
            );
          } else {
            executeSqliteQuerySync(
              database,
              db
                .insertInto("gateway_origin_device_tokens")
                .values({ ...values, gateway_scope: key.gateway_scope })
                .onConflict((conflict) =>
                  conflict.columns(["gateway_scope", "device_id", "role"]).doUpdateSet(values),
                ),
            );
          }
        }
        return { kind: "changed", changed: true };
      }
      case "socket.read":
      case "socket.create":
      case "socket.replace": {
        if (operation.kind === "socket.create") {
          const inserted = executeSqliteQuerySync(
            database,
            db
              .insertInto("native_exec_socket_credentials")
              .values(operation.socket)
              .onConflict((conflict) => conflict.column("socket_key").doNothing()),
          );
          if (inserted.numAffectedRows === 1n) {
            return { kind: "socket", socket: operation.socket };
          }
        }
        if (operation.kind === "socket.replace") {
          const current = executeSqliteQueryTakeFirstSync(
            database,
            db
              .selectFrom("native_exec_socket_credentials")
              .select("socket_token")
              .where("socket_key", "=", "current"),
          );
          if ((current?.socket_token ?? null) !== operation.expectedToken) {
            return { kind: "changed", changed: false };
          }
          executeSqliteQuerySync(
            database,
            db
              .insertInto("native_exec_socket_credentials")
              .values(operation.socket)
              .onConflict((conflict) =>
                conflict.column("socket_key").doUpdateSet(operation.socket),
              ),
          );
          return { kind: "changed", changed: true };
        }
        return {
          kind: "socket",
          socket:
            executeSqliteQueryTakeFirstSync(
              database,
              db
                .selectFrom("native_exec_socket_credentials")
                .selectAll()
                .where("socket_key", "=", "current"),
            ) ?? null,
        };
      }
      default:
        throw new Error("Unsupported client credential operation.");
    }
  });
  if (result) {
    return result;
  }
  switch (operation.kind) {
    case "identity.read":
      return { kind: "identity", identity: null };
    case "token.read":
      return { kind: "token", token: null };
    case "socket.read":
      return { kind: "socket", socket: null };
    case "token.remove":
      return { kind: "changed", changed: false };
    default:
      throw new Error("Client credential store creation did not complete.");
  }
}
