import type { DatabaseSync } from "node:sqlite";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { readSqliteIntegrityFileIdentity } from "../infra/sqlite-file-generation.js";
import { tryInspectSqliteReadOnlyInProcess } from "../infra/sqlite-readonly-inspection.js";
import { withSqliteSourceReadDatabase } from "../infra/sqlite-source-handle.js";
import { serializeAgentSchemaInspectionError } from "./openclaw-agent-schema-inspection-response.js";
import type { AgentSchemaInspectionSnapshot } from "./openclaw-agent-schema-inspection-worker.js";
import {
  inspectAgentDatabaseSchema,
  type AgentSchemaInspectionInput,
} from "./openclaw-agent-schema-inspection.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

if (!process.send || !process.disconnect) {
  throw new Error("Agent schema inspection requires parent IPC.");
}
const send = process.send.bind(process);
const disconnect = process.disconnect.bind(process);
// SAFETY: Only the schema preflight owner sends this private IPC input.
process.on(
  "message",
  (
    request:
      | { type: "close" }
      | {
          type: "inspect";
          requestId: number;
          input: AgentSchemaInspectionInput;
          snapshot?: AgentSchemaInspectionSnapshot;
        },
  ) => {
    if (request.type === "close") {
      disconnect();
      return;
    }
    const { requestId, input, snapshot } = request;
    try {
      const inspect = (database: DatabaseSync) => {
        setSqliteBusyTimeout(database, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
        if (input.requireStartupMigrationReadiness) {
          // sqlite-allow-raw -- Match the disposable integrity child's connection-local cache budget.
          database.exec("PRAGMA cache_size = -65536;");
        }
        return inspectAgentDatabaseSchema(database, input);
      };
      let inspection;
      if (snapshot) {
        // The parent retains its prepared copy until this reader closes the native handle.
        readSqliteIntegrityFileIdentity(snapshot.pathname, snapshot.identity);
        inspection = withSqliteSourceReadDatabase(snapshot.pathname, "snapshot", (database) => {
          readSqliteIntegrityFileIdentity(snapshot.pathname, snapshot.identity);
          return inspect(database);
        });
        readSqliteIntegrityFileIdentity(snapshot.pathname, snapshot.identity);
      } else {
        inspection = tryInspectSqliteReadOnlyInProcess(input.pathname, inspect)?.value;
      }
      send({
        requestId,
        ok: true,
        inspection: inspection
          ? {
              ...inspection,
              ...(inspection.failure
                ? { failure: serializeAgentSchemaInspectionError(inspection.failure) }
                : {}),
            }
          : null,
      });
    } catch (error) {
      send({ requestId, ok: false, error: serializeAgentSchemaInspectionError(error) });
    }
  },
);
