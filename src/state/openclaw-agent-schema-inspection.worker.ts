import type { DatabaseSync } from "node:sqlite";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { readSqliteIntegrityFileIdentity } from "../infra/sqlite-file-generation.js";
import { configureSqliteMaintenanceCache } from "../infra/sqlite-maintenance-cache.js";
import { tryInspectSqliteReadOnlyInProcess } from "../infra/sqlite-readonly-inspection.js";
import { withSqliteSourceReadDatabase } from "../infra/sqlite-source-handle.js";
import { StateDatabaseCoordinatorContentionError } from "../infra/state-database-coordinator.js";
import { serializeAgentSchemaInspectionError } from "./openclaw-agent-schema-inspection-response.js";
import type { AgentSchemaInspectionSnapshot } from "./openclaw-agent-schema-inspection-worker.js";
import {
  inspectAgentDatabaseSchema,
  type AgentSchemaInspectionInput,
} from "./openclaw-agent-schema-inspection.js";
import {
  canReuseOpenClawAgentIntegrityVerification,
  readOpenClawAgentIntegrityVerification,
} from "./openclaw-quarantine-store.js";
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
      const readVerification = () =>
        !snapshot && input.startupIntegrityStateDir
          ? readOpenClawAgentIntegrityVerification(input.pathname, {
              OPENCLAW_STATE_DIR: input.startupIntegrityStateDir,
            })
          : undefined;
      const inspect = (database: DatabaseSync, verification = readVerification()) => {
        setSqliteBusyTimeout(database, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
        if (input.requireStartupMigrationReadiness) {
          configureSqliteMaintenanceCache(database);
        }
        return inspectAgentDatabaseSchema(database, {
          ...input,
          startupIntegrityVerification: verification,
        });
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
        // Reuse the source fence for header-only reads of a closed WAL database.
        const headerOnly =
          !input.verifyCurrentSchemaShape && !input.requireStartupMigrationReadiness;
        if (
          !inspection &&
          (headerOnly ||
            canReuseOpenClawAgentIntegrityVerification(input.pathname, readVerification(), false))
        ) {
          try {
            inspection = withSqliteSourceReadDatabase(
              input.pathname,
              "source",
              (database) => {
                // sqlite-allow-raw -- Match the ordinary source reader's connection policy.
                database.exec("PRAGMA trusted_schema = OFF;");
                const verification = readVerification();
                return headerOnly ||
                  canReuseOpenClawAgentIntegrityVerification(input.pathname, verification, false)
                  ? inspect(database, verification)
                  : undefined;
              },
              "immutable",
            );
          } catch (error) {
            if (!(error instanceof StateDatabaseCoordinatorContentionError)) {
              throw error;
            }
          }
        }
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
