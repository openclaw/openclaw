import { createRequire } from "node:module";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";

const storeModulePath = createRequire(import.meta.url).resolve("@openclaw/fs-safe/store");

/** Native fixture processes must reread state under the same cross-process write lock. */
export function managedServiceStateUpdateScript(statePath: string, update: string): string {
  return `await require(${JSON.stringify(storeModulePath)}).jsonStore({
    filePath: ${JSON.stringify(statePath)}, lock: true,
  }).updateOr({}, (state) => { ${update}; return state; })`;
}

type GatewayRestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;

export function readRestartSentinelPayload(env: NodeJS.ProcessEnv, key = "current"): unknown {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_sentinel")
      .select(["version", "payload_json", "updated_at_ms"])
      .where("sentinel_key", "=", key),
  );
  return row
    ? { version: row.version, payload: JSON.parse(row.payload_json), revision: row.updated_at_ms }
    : null;
}
