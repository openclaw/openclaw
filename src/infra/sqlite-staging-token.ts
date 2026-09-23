import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql, type RawBuilder } from "kysely";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
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
  // Legacy callers may supply a parent without a token. Cooperating owners
  // create the same inode; SQLite arbitrates admission without recreating parents.
  const existingIdentity = existing ? readIdentity(location, "file") : undefined;
  const db = withSqliteNativeOpen(() =>
    openNodeSqliteDatabase(existing ? resolveExistingSqliteFileUri(location) : location),
  );
  let tokenIdentity: fs.BigIntStats;
  const kysely = getNodeSqliteKysely(db);
  const execute = (statement: RawBuilder<unknown>) =>
    executeSqliteQueryTakeFirstSync(db, { compile: () => statement.compile(kysely) });
  let exclusive = mode === "reclaim";
  let retired = false;
  const assertIdentity = () => {
    const currentDirectory = readIdentity(directory, "directory");
    const currentToken = readIdentity(location, "file");
    if (
      directoryIdentity.dev !== currentDirectory.dev ||
      directoryIdentity.ino !== currentDirectory.ino ||
      tokenIdentity.dev !== currentToken.dev ||
      tokenIdentity.ino !== currentToken.ino
    ) {
      throw new Error("SQLite staging ownership changed before retirement");
    }
  };
  const readVersion = () => {
    const row = execute(sql`PRAGMA user_version`);
    return isRecord(row) ? row.user_version : undefined;
  };
  const beginRetirement = (): SqliteStagingToken => {
    assertIdentity();
    if (!db.isOpen) {
      return acquireSqliteStagingToken(directory, "reclaim");
    }
    if (!db.isTransaction || !exclusive) {
      if (db.isTransaction) {
        execute(sql`ROLLBACK`);
      }
      execute(sql`BEGIN EXCLUSIVE`);
      exclusive = true;
    }
    // BEGIN cannot upgrade an existing transaction. Revalidate after the gap;
    // a rival owner may have retired or replaced this directory in between.
    assertIdentity();
    const version = readVersion();
    if (version !== (retired ? 1 : 0)) {
      // Reject the losing attempt without deleting bytes; a later ordinary
      // cleanup may reclaim the same identity's authoritative retired marker.
      retired = version === 1;
      throw new SqliteStagingRetiredError();
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
        execute(sql`PRAGMA user_version=1`);
      }
      execute(sql`COMMIT`);
      retired = true;
    } else if (db.isTransaction) {
      // Bun can retain statements after close_v2; end the transaction now so
      // a released worker cannot keep its parent's retirement commit locked.
      execute(sql`ROLLBACK`);
    }
    db.close();
  };
  const token = Object.assign(release, { beginRetirement });
  try {
    tokenIdentity = existingIdentity ?? readIdentity(location, "file");
    execute(sql`PRAGMA busy_timeout=0`);
    if (mode === "create") {
      execute(sql`BEGIN IMMEDIATE`);
    } else if (mode === "reclaim") {
      execute(sql`BEGIN EXCLUSIVE`);
    } else {
      execute(sql`BEGIN`);
      execute(sql`SELECT rootpage FROM sqlite_schema LIMIT 1`);
    }
    const journalMode = execute(sql`PRAGMA journal_mode`);
    if (!isRecord(journalMode) || journalMode.journal_mode !== "delete") {
      throw new Error("SQLite snapshot token journal mode is unknown");
    }
    const version = readVersion();
    if (version !== 0 && (mode !== "reclaim" || version !== 1)) {
      throw new SqliteStagingRetiredError();
    }
    retired = version === 1;
    assertIdentity();
    return token;
  } catch (error) {
    release();
    throw error;
  }
}
