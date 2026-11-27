import fs from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readRestartSentinelRowSync } from "./restart-sentinel-store.js";

const storeModulePath = createRequire(import.meta.url).resolve("@openclaw/fs-safe/store");

/** Native fixture processes must reread state under the same cross-process write lock. */
export function managedServiceStateUpdateScript(statePath: string, update: string): string {
  return `await require(${JSON.stringify(storeModulePath)}).jsonStore({
    filePath: ${JSON.stringify(statePath)}, lock: true,
  }).updateOr({}, (state) => { ${update}; return state; })`;
}

// The JSON shadow can retain fields that the Gateway's typed reader cannot see.
export function readRestartSentinelPayload(env: NodeJS.ProcessEnv): unknown {
  const pathname = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(pathname)) {
    return null;
  }
  const database = new DatabaseSync(pathname, { readOnly: true });
  try {
    const current = readRestartSentinelRowSync(database);
    if (current.kind === "invalid") {
      throw new Error("Expected a valid typed restart sentinel fixture");
    }
    return current.kind === "valid" ? current.sentinel : null;
  } finally {
    database.close();
  }
}

export function readManagedServiceHandoffLease(
  databasePath: string,
  installRoot: string,
  owner: string,
): Record<string, unknown> | null {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT payload_json FROM managed_update_handoffs WHERE install_root = ? AND owner = ?",
      )
      .get(installRoot, owner) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as Record<string, unknown>) : null;
  } finally {
    db.close();
  }
}
