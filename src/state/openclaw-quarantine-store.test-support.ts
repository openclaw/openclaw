import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import {
  serializeSqliteFileGeneration,
  type SqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import type { OpenClawDatabaseKind } from "./openclaw-quarantine-error.js";
import { ensureOpenClawQuarantineStore } from "./openclaw-quarantine-store.js";
import { resolveQuarantineStorePath } from "./openclaw-state-db.paths.js";

/** Seed a historical quarantine without restoring the retired runtime verifier. */
export function seedOpenClawDatabaseQuarantine(options: {
  env?: NodeJS.ProcessEnv;
  generation?: SqliteFileGeneration;
  kind: OpenClawDatabaseKind;
  path: string;
  reason: string;
}): void {
  const env = options.env ?? process.env;
  ensureOpenClawQuarantineStore(env);
  const storePath = resolveQuarantineStorePath(env);
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(storePath);
  try {
    database
      .prepare(`INSERT OR REPLACE INTO quarantined_databases
        (path, kind, reason, quarantined_at, verified_generation) VALUES (?, ?, ?, ?, ?)`)
      .run(
        path.resolve(options.path),
        options.kind,
        options.reason,
        Date.now(),
        options.generation ? serializeSqliteFileGeneration(options.generation) : null,
      );
  } finally {
    database.close();
  }
  // Tests can seed after readers are warm; their next read must load the persisted fixture.
  revokeSqliteDatabaseAdmissionsForPath(storePath);
  revokeSqliteDatabaseAdmissionsForPath(options.path);
}

/** Inspect persisted rows independently of quarantine admission and generation policy. */
export function readPersistedQuarantineRow(pathname: string, options: { env: NodeJS.ProcessEnv }) {
  const stateDir = options.env.OPENCLAW_STATE_DIR;
  assert(typeof stateDir === "string" && path.isAbsolute(stateDir));
  const storePath = path.join(stateDir, "state", "openclaw-quarantine.sqlite");
  if (!existsSync(storePath)) {
    return undefined;
  }
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(storePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT kind, reason, quarantined_at AS quarantinedAt FROM quarantined_databases WHERE path = ?",
      )
      .get(path.resolve(pathname));
    if (!row) {
      return undefined;
    }
    assert(row.kind === "agent" || row.kind === "state");
    assert(typeof row.reason === "string");
    assert(typeof row.quarantinedAt === "number");
    return { kind: row.kind, reason: row.reason, quarantinedAt: row.quarantinedAt };
  } finally {
    database.close();
  }
}
