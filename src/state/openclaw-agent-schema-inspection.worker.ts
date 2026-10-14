import type { DatabaseSync } from "node:sqlite";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { readSqliteDatabaseIntegrityVerification } from "../infra/sqlite-database-admission.js";
import { readSqliteIntegrityFileIdentity } from "../infra/sqlite-file-generation.js";
import { configureSqliteMaintenanceCache } from "../infra/sqlite-maintenance-cache.js";
import { tryInspectSqliteReadOnlyInProcess } from "../infra/sqlite-readonly-inspection.js";
import { adoptSqliteSchemaContracts } from "../infra/sqlite-schema-contract.js";
import { withSqliteSourceReadDatabase } from "../infra/sqlite-source-handle.js";
import {
  serializeAgentSchemaInspectionError,
  type AgentSchemaInspectionResponse,
} from "./openclaw-agent-schema-inspection-response.js";
import type { AgentSchemaInspectionSnapshot } from "./openclaw-agent-schema-inspection-worker.js";
import {
  inspectAgentDatabaseSchema,
  type AgentSchemaInspectionInput,
} from "./openclaw-agent-schema-inspection.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";
import {
  captureStateSchemaInspectionContracts,
  inspectStateDatabaseSchema,
  type StateSchemaInspectionInput,
} from "./openclaw-state-schema-preflight.js";

if (!process.send || !process.disconnect) {
  throw new Error("Agent schema inspection requires parent IPC.");
}
const send = (response: AgentSchemaInspectionResponse) => process.send?.(response);
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
        }
      | {
          type: "inspect-state";
          requestId: number;
          input: StateSchemaInspectionInput;
          snapshot: AgentSchemaInspectionSnapshot;
        },
  ) => {
    if (request.type === "close") {
      disconnect();
      return;
    }
    const { requestId } = request;
    try {
      if (request.type === "inspect-state") {
        const { input, snapshot } = request;
        adoptSqliteSchemaContracts(input.schemaContracts ?? []);
        readSqliteIntegrityFileIdentity(snapshot.pathname, snapshot.identity);
        const inspection = withSqliteSourceReadDatabase(
          snapshot.pathname,
          "snapshot",
          (database) => {
            readSqliteIntegrityFileIdentity(snapshot.pathname, snapshot.identity);
            return inspectStateDatabaseSchema(database, input);
          },
          { timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS },
        );
        readSqliteIntegrityFileIdentity(snapshot.pathname, snapshot.identity);
        send({
          requestId,
          ok: true,
          inspection: null,
          schemaContracts: captureStateSchemaInspectionContracts().filter(
            (contract) =>
              !input.schemaContracts?.some((prior) => prior.schemaSql === contract.schemaSql),
          ),
          stateInspection: {
            ...inspection,
            inspectionErrors: inspection.inspectionErrors.map(serializeAgentSchemaInspectionError),
          },
        });
        return;
      }
      const { input, snapshot } = request;
      const readVerification = () =>
        !snapshot && input.requireStartupMigrationReadiness
          ? readSqliteDatabaseIntegrityVerification(input.pathname)
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
        inspection = tryInspectSqliteReadOnlyInProcess(input.pathname, inspect, {
          allowClosedWal: readVerification() !== undefined,
        })?.value;
      }
      send({
        requestId,
        ok: true,
        inspection: inspection
          ? {
              ...inspection,
              failure: inspection.failure
                ? serializeAgentSchemaInspectionError(inspection.failure)
                : undefined,
            }
          : null,
      });
    } catch (error) {
      send({ requestId, ok: false, error: serializeAgentSchemaInspectionError(error) });
    }
  },
);
