// Octopus Orchestrator — registry SQLite migration / bootstrap (M1-01)
//
// Creates and opens the Octopus registry SQLite database at
// `<stateDir>/octo/registry.sqlite`, applying the schema defined in
// `schema.sql`. This is the persistence backing for the M1-02
// RegistryService (missions, arms, grips, claims, leases, artifacts).
//
// Context docs:
//   - LLD §Storage Choices — SQLite for MVP, path layout, CAS via `version`
//   - LLD §Core Domain Objects — canonical field lists
//   - DECISIONS.md OCTO-DEC-010 — SQLite for MVP storage
//
// Boundary discipline (OCTO-DEC-033 / OCTO-DEC-040):
//   This file lives OUTSIDE `src/octo/adapters/openclaw/**`, so it must not
//   import OpenClaw internals. It intentionally imports only from:
//     - `node:*` builtins (fs, os, path, module, url, sqlite)
//     - no third-party packages
//     - no relative paths outside `src/octo/`
//   `node:sqlite` is a Node 22+ built-in and is explicitly allowed by
//   `scripts/check-octo-upstream-imports.mjs` (`isNodeBuiltin`). We do NOT
//   import `src/infra/node-sqlite.ts` — its friendly-error wrapper is
//   replicated inline below (~15 lines) to keep the blast radius scoped to
//   this file and to respect the boundary rule.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const REGISTRY_SUBPATH = path.join("octo", "registry.sqlite");
const REGISTRY_FILE_MODE = 0o600;
const REGISTRY_DIR_MODE = 0o700;

type NodeSqliteModule = typeof import("node:sqlite");

// Inline replica of src/infra/node-sqlite.ts#requireNodeSqlite: load
// node:sqlite via createRequire so a runtime without SQLite support fails
// with a clear error instead of a cryptic MODULE_NOT_FOUND. Direct
// `import "node:sqlite"` would also throw, but at module evaluation time,
// before any of this file's helpers have a chance to surface a friendly
// message.
function loadNodeSqlite(): NodeSqliteModule {
  const requireFromHere = createRequire(import.meta.url);
  try {
    return requireFromHere("node:sqlite") as NodeSqliteModule;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SQLite support is unavailable in this Node runtime (missing node:sqlite). ${detail}`,
      { cause: err },
    );
  }
}

/**
 * Resolve the absolute path to the Octopus registry SQLite file.
 *
 * Honours `OPENCLAW_STATE_DIR` when set (trimmed, non-empty); otherwise
 * falls back to `<home>/.openclaw`. Appends `octo/registry.sqlite`.
 */
export function resolveOctoRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  const stateDir =
    override && override.length > 0 ? override : path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, REGISTRY_SUBPATH);
}

/**
 * Load and apply `schema.sql` to `db`. Idempotent — all CREATE statements
 * use `IF NOT EXISTS`, so applying the schema twice is a no-op.
 */
export function applySchema(db: DatabaseSync): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.join(here, "schema.sql");
  const sql = readFileSync(schemaPath, "utf8");
  db.exec(sql);
}

export interface OpenOctoRegistryOptions {
  /** Override the database file path. Tests pass a temp path here. */
  path?: string;
}

/**
 * Open (creating if missing) the Octopus registry SQLite database and apply
 * the schema. Ensures the parent directory exists and tightens file mode to
 * 0600 on first creation (POSIX only). Returns the open DatabaseSync handle.
 */
export function openOctoRegistry(options: OpenOctoRegistryOptions = {}): DatabaseSync {
  const dbPath = options.path ?? resolveOctoRegistryPath();
  const parent = path.dirname(dbPath);
  mkdirSync(parent, { recursive: true, mode: REGISTRY_DIR_MODE });

  const preExisting = existsSync(dbPath);
  const sqlite = loadNodeSqlite();
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = OFF;");

  applySchema(db);

  if (!preExisting && existsSync(dbPath) && process.platform !== "win32") {
    try {
      chmodSync(dbPath, REGISTRY_FILE_MODE);
    } catch {
      // best-effort; filesystems that do not support chmod (e.g. some
      // network mounts) should not crash the bootstrap.
    }
  }

  // Ensure on-disk mode is 0600 even if the DB file already existed and was
  // created with a laxer umask by a prior run.
  if (process.platform !== "win32") {
    try {
      const stat = statSync(dbPath);
      if ((stat.mode & 0o777) !== REGISTRY_FILE_MODE) {
        chmodSync(dbPath, REGISTRY_FILE_MODE);
      }
    } catch {
      // ignore
    }
  }

  return db;
}

/**
 * Close the Octopus registry database. Trivial symmetry wrapper around
 * `db.close()`; exists so callers do not need to import node:sqlite types
 * just to release the handle.
 */
export function closeOctoRegistry(db: DatabaseSync): void {
  db.close();
}
