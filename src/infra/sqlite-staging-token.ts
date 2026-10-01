import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql, type RawBuilder } from "kysely";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { withSqliteNativeOpen } from "./sqlite-error-diagnostics.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";

export const SQLITE_STAGING_TOKEN_FILES = [
  "owner.sqlite",
  "owner.sqlite-journal",
  "owner.sqlite-wal",
  "owner.sqlite-shm",
] as const;

export type SqliteStagingTokenIdentity = Readonly<{
  directory: Readonly<{ dev: string; ino: string }>;
  token: Readonly<{ dev: string; ino: string }>;
}>;

export function readSqliteStagingTokenIdentity(value: unknown): SqliteStagingTokenIdentity {
  if (!isRecord(value) || !isRecord(value.directory) || !isRecord(value.token)) {
    throw new Error("SQLite staging token requires an exact filesystem identity");
  }
  const read = (part: Record<string, unknown>) => {
    if (
      typeof part.dev !== "string" ||
      !/^\d+$/.test(part.dev) ||
      typeof part.ino !== "string" ||
      !/^\d+$/.test(part.ino)
    ) {
      throw new Error("SQLite staging token identity is invalid");
    }
    return Object.freeze({ dev: part.dev, ino: part.ino });
  };
  return Object.freeze({ directory: read(value.directory), token: read(value.token) });
}

export function captureSqliteStagingTokenIdentity(
  directory: string,
  mode: "create" | "reclaim",
  expectedDirectoryIdentity?: SqliteStagingTokenIdentity["directory"],
): SqliteStagingTokenIdentity {
  const directoryStat = fs.lstatSync(directory, { bigint: true });
  if (!directoryStat.isDirectory()) {
    throw new Error("SQLite staging directory ownership is unknown");
  }
  if (
    expectedDirectoryIdentity &&
    (String(directoryStat.dev) !== expectedDirectoryIdentity.dev ||
      String(directoryStat.ino) !== expectedDirectoryIdentity.ino)
  ) {
    throw new Error("SQLite staging directory ownership changed before token creation");
  }
  const location = path.join(directory, SQLITE_STAGING_TOKEN_FILES[0]);
  let tokenStat: fs.BigIntStats;
  if (mode === "create") {
    const fd = fs.openSync(location, "wx", 0o600);
    try {
      tokenStat = fs.fstatSync(fd, { bigint: true });
    } finally {
      fs.closeSync(fd);
    }
  } else {
    tokenStat = fs.lstatSync(location, { bigint: true });
  }
  if (
    !tokenStat.isFile() ||
    (process.platform === "win32" &&
      [directoryStat.dev, directoryStat.ino, tokenStat.dev, tokenStat.ino].includes(0n))
  ) {
    throw new Error("SQLite staging token ownership is unknown");
  }
  const identity = readSqliteStagingTokenIdentity({
    directory: { dev: String(directoryStat.dev), ino: String(directoryStat.ino) },
    token: { dev: String(tokenStat.dev), ino: String(tokenStat.ino) },
  });
  assertSqliteStagingTokenIdentity(directory, identity);
  return identity;
}

export function assertSqliteStagingTokenIdentity(
  directory: string,
  expected: SqliteStagingTokenIdentity,
): void {
  for (const [pathname, kind, identity] of [
    [directory, "directory", expected.directory],
    [path.join(directory, SQLITE_STAGING_TOKEN_FILES[0]), "file", expected.token],
  ] as const) {
    const stat = fs.lstatSync(pathname, { bigint: true });
    if (
      !(kind === "directory" ? stat.isDirectory() : stat.isFile()) ||
      String(stat.dev) !== identity.dev ||
      String(stat.ino) !== identity.ino ||
      (process.platform === "win32" && (stat.dev === 0n || stat.ino === 0n))
    ) {
      throw new Error("SQLite staging token ownership changed");
    }
  }
}

export type SqliteStagingToken = ((retiring?: boolean) => void) & {
  beginRetirement: () => SqliteStagingToken;
};
export type IdentifiedSqliteStagingToken = SqliteStagingToken & {
  getIdentity(): SqliteStagingTokenIdentity;
};

export class SqliteStagingRetiredError extends Error {
  readonly code = "SQLITE_STAGING_RETIRED";
  constructor() {
    super("SQLite snapshot parent retired; aborting snapshot allocation");
    this.name = "SqliteStagingRetiredError";
  }
}

/** Native transactions fence private staging admission and committed retirement. */
export function acquireSqliteStagingToken(
  directory: string,
  mode: "create" | "read" | "reclaim",
  options: {
    expectedIdentity: SqliteStagingTokenIdentity;
    retainCleanup?: (token: IdentifiedSqliteStagingToken) => void;
  },
): IdentifiedSqliteStagingToken;
export function acquireSqliteStagingToken(
  directory: string,
  mode: "create" | "read" | "reclaim",
  options?: { allowMissing?: boolean },
): SqliteStagingToken;
export function acquireSqliteStagingToken(
  directory: string,
  mode: "create" | "read" | "reclaim",
  options: {
    allowMissing?: boolean;
    expectedIdentity?: SqliteStagingTokenIdentity;
    retainCleanup?: (token: IdentifiedSqliteStagingToken) => void;
  } = {},
): SqliteStagingToken {
  if (options.expectedIdentity) {
    assertSqliteStagingTokenIdentity(directory, options.expectedIdentity);
  }
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
    openNodeSqliteDatabase(
      existing || options.expectedIdentity ? resolveExistingSqliteFileUri(location) : location,
    ),
  );
  let tokenIdentity: fs.BigIntStats;
  const kysely = getNodeSqliteKysely(db);
  const execute = (statement: RawBuilder<unknown>) =>
    executeSqliteQueryTakeFirstSync(db, { compile: () => statement.compile(kysely) });
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
  const readVersion = () => {
    const row = execute(sql`PRAGMA user_version`);
    return isRecord(row) ? row.user_version : undefined;
  };
  const beginRetirement = (): SqliteStagingToken => {
    assertIdentity();
    if (!db.isOpen) {
      if (options.expectedIdentity) {
        throw new Error("SQLite staging token is closed");
      }
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
      if (retiring && options.expectedIdentity) {
        throw new Error("SQLite staging token is closed");
      }
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
  const token: IdentifiedSqliteStagingToken = Object.assign(release, {
    beginRetirement,
    getIdentity: () =>
      readSqliteStagingTokenIdentity({
        directory: { dev: String(directoryIdentity.dev), ino: String(directoryIdentity.ino) },
        token: { dev: String(tokenIdentity.dev), ino: String(tokenIdentity.ino) },
      }),
  });
  try {
    tokenIdentity = existingIdentity ?? readIdentity(location, "file");
    assertIdentity();
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
    if (options.expectedIdentity) {
      assertSqliteStagingTokenIdentity(directory, options.expectedIdentity);
    }
    return token;
  } catch (error) {
    try {
      release();
    } catch (cleanupError) {
      options.retainCleanup?.(token);
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "SQLite staging admission cleanup failed",
        error,
      );
    }
    throw error;
  }
}
