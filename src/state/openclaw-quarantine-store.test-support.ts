import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { requireNodeSqlite } from "../infra/node-sqlite.js";

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
