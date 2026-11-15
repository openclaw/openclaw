import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import {
  getOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";

type NativeAgentDatabase = OpenClawAgentDatabase & { db: DatabaseSync };

function assertNativeAgentDatabase(
  database: OpenClawAgentDatabase,
): asserts database is NativeAgentDatabase {
  if (isPostgresSqlConnection(database.db)) {
    throw new Error("Native validation fixture requires SQLite");
  }
}

export async function withReceiptFixture(
  populated: boolean,
  run: (
    database: NativeAgentDatabase,
    options: OpenClawAgentDatabaseOptions,
  ) => void | Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    let database = openOpenClawAgentDatabase(options);
    assertNativeAgentDatabase(database);
    if (populated) {
      database.db.exec(`INSERT INTO session_nodes
        (session_key, current_session_id, entry_json, updated_at)
        VALUES ('agent:main:existing', 'existing', '{"sessionId":"existing","updatedAt":1}', 1);
        UPDATE session_nodes SET entry_valid = 1;
        DELETE FROM session_canonical_validation_pending;`);
      invalidateOpenClawAgentDatabaseValidation(database.path);
      closeOpenClawAgentDatabaseByPath(database.path);
      database = openOpenClawAgentDatabase(options);
      assertNativeAgentDatabase(database);
    }
    await run(database, options);
  });
}

export function independentWorkerReceipt(database: OpenClawAgentDatabase) {
  const receipt = getOpenClawAgentDatabaseValidation(database);
  if (!receipt) {
    throw new Error("Expected physical validation receipt");
  }
  // A native first opener can establish proof before the host has any receipt.
  return {
    ...receipt,
    receiptId: randomUUID(),
    valid: receipt.valid.slice(0),
    canonicalReady: receipt.canonicalReady.slice(0),
  };
}
