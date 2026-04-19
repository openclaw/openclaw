import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  MINIONS_DIR_MODE,
  MINIONS_FILE_MODE,
  MINIONS_SIDECAR_SUFFIXES,
  resolveMinionsDir,
  resolveMinionsSqlitePath,
} from "./paths.js";
import { applyMinionPragmas, ensureMinionSchema } from "./schema.js";

type CachedDatabase = {
  db: DatabaseSync;
  path: string;
};

let cached: CachedDatabase | null = null;

function ensureMinionsPermissions(pathname: string): void {
  const dir = resolveMinionsDir(process.env);
  mkdirSync(dir, { recursive: true, mode: MINIONS_DIR_MODE });
  chmodSync(dir, MINIONS_DIR_MODE);
  for (const suffix of MINIONS_SIDECAR_SUFFIXES) {
    const candidate = `${pathname}${suffix}`;
    if (!existsSync(candidate)) {
      continue;
    }
    chmodSync(candidate, MINIONS_FILE_MODE);
  }
}

function openDatabase(): CachedDatabase {
  const pathname = resolveMinionsSqlitePath(process.env);
  if (cached && cached.path === pathname) {
    return cached;
  }
  if (cached) {
    cached.db.close();
    cached = null;
  }
  ensureMinionsPermissions(pathname);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  applyMinionPragmas(db);
  ensureMinionSchema(db);
  ensureMinionsPermissions(pathname);
  cached = { db, path: pathname };
  return cached;
}

/**
 * Explicit DB open helper for custom paths (tests, doctor migration). Caller
 * owns the lifecycle.
 */
export function openMinionsDatabaseAt(pathname: string): DatabaseSync {
  mkdirSync(path.dirname(pathname), { recursive: true, mode: MINIONS_DIR_MODE });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  applyMinionPragmas(db);
  ensureMinionSchema(db);
  return db;
}

/**
 * Replace the process-wide singleton with a custom-path DB. Returns a dispose
 * function. For tests only — production code should use the default path.
 */
export function configureMinionsStoreForTests(pathname: string): () => void {
  if (cached) {
    cached.db.close();
    cached = null;
  }
  const db = openMinionsDatabaseAt(pathname);
  cached = { db, path: pathname };
  return () => {
    if (cached && cached.path === pathname) {
      cached.db.close();
      cached = null;
    }
  };
}

export function resetMinionsStoreForTests(): void {
  if (cached) {
    cached.db.close();
    cached = null;
  }
}

export class MinionStore {
  private readonly owned: boolean;
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync, owned: boolean) {
    this.db = db;
    this.owned = owned;
  }

  /** Open the process-wide store at the default path. */
  static openDefault(): MinionStore {
    const { db } = openDatabase();
    return new MinionStore(db, false);
  }

  /** Open an ad-hoc store at a caller-chosen path (tests, doctor migration). */
  static openAt(pathname: string): MinionStore {
    const db = openMinionsDatabaseAt(pathname);
    return new MinionStore(db, true);
  }

  close(): void {
    if (this.owned) {
      this.db.close();
    }
  }

  /**
   * Run `fn` inside a BEGIN IMMEDIATE transaction. `BEGIN IMMEDIATE` acquires
   * the reserved lock upfront so `SELECT … FOR UPDATE`-style parent locking
   * (used by MinionQueue.add) serializes cleanly.
   */
  transaction<T>(fn: (db: DatabaseSync) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn(this.db);
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure is secondary to the original error.
      }
      throw error;
    }
  }

  /**
   * CAS helper. Use `.all()` instead of `.run()` so `UPDATE … RETURNING`
   * gives back rows when the CAS guard hits, and an empty array when it
   * doesn't. Handlers that see an empty array must bail silently — a newer
   * attempt already owns the row.
   */
  casUpdate<T = unknown>(sql: string, params: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...(params as [])) as T[];
  }
}
