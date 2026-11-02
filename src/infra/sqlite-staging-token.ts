import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeWithCachedStatement } from "./kysely-sync-cache-state.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { retireSqliteDatabaseAdmissionForPath } from "./sqlite-database-admission.js";
import { withSqliteNativeOpen } from "./sqlite-error-diagnostics.js";

export const SQLITE_STAGING_TOKEN_FILES = [
  "owner.sqlite",
  "owner.sqlite-journal",
  "owner.sqlite-wal",
  "owner.sqlite-shm",
] as const;

export type SqliteStagingToken = ((retiring?: boolean) => void) & {
  beginRetirement: () => SqliteStagingToken;
};

export class SqliteStagingRetiredError extends Error {
  constructor() {
    super("SQLite snapshot parent retired; aborting snapshot allocation");
  }
}

/** Native transactions fence private staging admission and committed retirement. */
export function acquireSqliteStagingToken(
  directory: string,
  mode: "create" | "read" | "reclaim",
  options: { allowMissing?: boolean } = {},
): SqliteStagingToken {
  const location = path.join(directory, SQLITE_STAGING_TOKEN_FILES[0]);
  const readIdentity = (pathname: string, kind: "directory" | "file") => {
    const stat = fs.lstatSync(pathname, { bigint: true });
    // Windows may report zero identities under contention. Read-compatible
    // identity matching is insufficient authority for destructive retirement.
    if (
      !(kind === "directory" ? stat.isDirectory() : stat.isFile()) ||
      (process.platform === "win32" && (stat.dev === 0n || stat.ino === 0n))
    ) {
      throw new Error("SQLite staging ownership is unknown");
    }
    return stat;
  };
  const directoryIdentity = readIdentity(directory, "directory");
  // Check sidecars before SQLite may recover or remove a private journal.
  const family = SQLITE_STAGING_TOKEN_FILES.map((file) =>
    fs.lstatSync(path.join(directory, file), { throwIfNoEntry: false }),
  );
  const existing = family[0];
  if (
    family.some(
      (file) => file && (!file.isFile() || (process.getuid && file.uid !== process.getuid())),
    ) ||
    (!existing && mode !== "create" && !options.allowMissing)
  ) {
    throw new Error("SQLite snapshot token ownership is unknown");
  }
  if (mode === "create" && !existing) {
    // Snapshot, plugin capture, and backup owners create before publishing their private directory.
    fs.writeFileSync(location, "", { flag: "wx", mode: 0o644 });
  }
  const tokenExists = existing !== undefined || mode === "create";
  // Legacy readers may supply a parent without a token; fresh owners never recreate a removed inode.
  const existingIdentity = tokenExists ? readIdentity(location, "file") : undefined;
  const db = withSqliteNativeOpen(() =>
    openNodeSqliteDatabase(tokenExists ? resolveExistingSqliteFileUri(location) : location, {
      timeout: 0,
    }),
  );
  let tokenIdentity: fs.BigIntStats;
  // This lock primitive needs fixed SQLite commands, not the query-builder graph.
  const read = (sql: string) =>
    executeWithCachedStatement(db, sql, [], (statement) => statement.get());
  let exclusive = mode === "reclaim";
  let retired = false;
  const assertIdentity = () => {
    const currentDirectory = readIdentity(directory, "directory");
    if (
      directoryIdentity.dev !== currentDirectory.dev ||
      directoryIdentity.ino !== currentDirectory.ino
    ) {
      throw new Error("SQLite staging ownership changed before retirement");
    }
    const currentToken = readIdentity(location, "file");
    if (tokenIdentity.dev !== currentToken.dev || tokenIdentity.ino !== currentToken.ino) {
      throw new Error("SQLite staging ownership changed before retirement");
    }
  };
  const beginRetirement = (): SqliteStagingToken => {
    assertIdentity();
    if (!db.isTransaction || !exclusive) {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      db.exec("BEGIN EXCLUSIVE");
      exclusive = true;
    }
    return token;
  };
  const release = (retiring = false) => {
    if (!db.isOpen) {
      return;
    }
    if (retiring) {
      // Windows handles omit FILE_SHARE_DELETE: commit retirement while fenced,
      // then close for removal. Late workers reject the committed marker.
      beginRetirement();
      if (!retired) {
        db.exec("PRAGMA user_version=1");
      }
      db.exec("COMMIT");
      retired = true;
    } else if (db.isTransaction) {
      // Bun can retain statements after close_v2; end the transaction now so
      // a released worker cannot keep its parent's retirement commit locked.
      db.exec("ROLLBACK");
    }
    db.close();
    if (retiring) {
      retireSqliteDatabaseAdmissionForPath(location);
    }
  };
  const token = Object.assign(release, { beginRetirement });
  try {
    tokenIdentity = existingIdentity ?? readIdentity(location, "file");
    if (mode === "create") {
      db.exec("BEGIN IMMEDIATE");
    } else if (mode === "reclaim") {
      db.exec("BEGIN EXCLUSIVE");
    } else {
      db.exec("BEGIN");
    }
    // A private wx-created empty token has the native DELETE journal and zero marker.
    // Existing tokens need their marker read under the lock; this also pins read custody.
    if (mode !== "create" || existing) {
      const journalMode = read("PRAGMA journal_mode");
      if (!isRecord(journalMode) || journalMode.journal_mode !== "delete") {
        throw new Error("SQLite snapshot token journal mode is unknown");
      }
      const header = read("PRAGMA user_version");
      const version = isRecord(header) ? header.user_version : undefined;
      if (version !== 0 && (mode !== "reclaim" || version !== 1)) {
        throw new SqliteStagingRetiredError();
      }
      retired = version === 1;
    }
    assertIdentity();
    return token;
  } catch (error) {
    release();
    throw error;
  }
}
