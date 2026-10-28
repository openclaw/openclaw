import type { DatabaseSync } from "node:sqlite";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { ClientCredentialDatabase } from "./client-credential-schema.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

export function sanitizeClientCredentialSnapshot(database: DatabaseSync): void {
  if (tableExists(database, "native_exec_socket_credentials")) {
    executeSqliteQuerySync(
      database,
      getNodeSqliteKysely<ClientCredentialDatabase>(database)
        .updateTable("native_exec_socket_credentials")
        .set({ socket_token: null }),
    );
  }
}
