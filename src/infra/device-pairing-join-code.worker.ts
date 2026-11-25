import { ensureDevicePairingJoinCodeSchema } from "../state/openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { EngineConnection } from "./sql-connection.js";
import { deferSqlitePostCommitPublication } from "./sqlite-post-commit.js";

type JoinCodeDatabase = Pick<OpenClawStateKyselyDatabase, "device_pairing_join_codes">;
const initializedDatabases = new WeakSet<EngineConnection>();

function joinCodeDatabase(db: EngineConnection) {
  if (!initializedDatabases.has(db)) {
    ensureDevicePairingJoinCodeSchema(db);
    // A refused commit also rolls back first-use DDL.
    deferSqlitePostCommitPublication(db, () => initializedDatabases.add(db));
  }
  return getNodeSqliteKysely<JoinCodeDatabase>(db);
}

export function registerDevicePairingJoinCodeInWorker(
  db: EngineConnection,
  input: { shortcode: string; payloadJson: string; createdAtMs: number; expiresAtMs: number },
): void {
  const kysely = joinCodeDatabase(db);
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("device_pairing_join_codes").where("expires_at_ms", "<=", input.createdAtMs),
  );
  executeSqliteQuerySync(
    db,
    kysely.insertInto("device_pairing_join_codes").values({
      shortcode: input.shortcode,
      payload_json: input.payloadJson,
      created_at_ms: input.createdAtMs,
      expires_at_ms: input.expiresAtMs,
    }),
  );
}

export function redeemDevicePairingJoinCodeInWorker(
  db: EngineConnection,
  input: { shortcode: string },
) {
  const nowMs = Date.now();
  const kysely = joinCodeDatabase(db);
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("device_pairing_join_codes").where("expires_at_ms", "<=", nowMs),
  );
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .deleteFrom("device_pairing_join_codes")
      .where("shortcode", "=", input.shortcode)
      .returning(["payload_json", "expires_at_ms"]),
  );
  // Malformed rows must still be burned before their result is discarded.
  if (!row || typeof row.payload_json !== "string" || typeof row.expires_at_ms !== "number") {
    return undefined;
  }
  return { payload_json: row.payload_json, expires_at_ms: row.expires_at_ms };
}
