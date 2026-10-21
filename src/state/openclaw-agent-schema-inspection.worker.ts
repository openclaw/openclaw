import type { DatabaseSync } from "node:sqlite";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import {
  withDatabaseEngineSelection,
  type DatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { readSqliteDatabaseIntegrityVerification } from "../infra/sqlite-database-admission.js";
import { readSqliteIntegrityFileIdentity } from "../infra/sqlite-file-generation.js";
import { tryInspectSqliteReadOnlyInProcess } from "../infra/sqlite-readonly-inspection.js";
import { withSqliteSourceReadDatabase } from "../infra/sqlite-source-handle.js";
import { readExistingAgentSchemaMeta } from "./openclaw-agent-db-metadata.js";
import { withFreshOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-open.js";
import { readAgentDatabaseSchemaVersion } from "./openclaw-agent-db-schema-read.js";
import {
  serializeAgentSchemaInspectionError,
  type AgentSchemaInspectionResponse,
} from "./openclaw-agent-schema-inspection-response.js";
import type { AgentSchemaInspectionSnapshot } from "./openclaw-agent-schema-inspection-worker.js";
import type { AgentSchemaInspectionInput } from "./openclaw-agent-schema-inspection.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";
import type { StateSchemaInspectionInput } from "./openclaw-state-schema-preflight.js";

if (!process.send || !process.disconnect) {
  throw new Error("Agent schema inspection requires parent IPC.");
}
const send = (response: AgentSchemaInspectionResponse) => process.send?.(response);
const disconnect = process.disconnect.bind(process);
type InspectionRequest =
  | {
      type: "inspect";
      requestId: number;
      input: AgentSchemaInspectionInput;
      snapshot?: AgentSchemaInspectionSnapshot;
      databaseEngineSelection?: DatabaseEngineSelection;
    }
  | {
      type: "inspect-state";
      requestId: number;
      input: StateSchemaInspectionInput;
      snapshot?: AgentSchemaInspectionSnapshot;
    };

async function inspectRequest(request: InspectionRequest): Promise<void> {
  const { requestId } = request;
  try {
    if (request.type === "inspect-state") {
      const { input, snapshot } = request;
      const { inspectStateDatabaseSchema } = await import("./openclaw-state-schema-preflight.js");
      const inspect = (database: DatabaseSync) => inspectStateDatabaseSchema(database, input);
      let inspection;
      if (snapshot) {
        readSqliteIntegrityFileIdentity(snapshot.pathname, snapshot.identity);
        inspection = withSqliteSourceReadDatabase(
          snapshot.pathname,
          "snapshot",
          (database) => {
            readSqliteIntegrityFileIdentity(snapshot.pathname, snapshot.identity);
            return inspect(database);
          },
          { timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS },
        );
        readSqliteIntegrityFileIdentity(snapshot.pathname, snapshot.identity);
      } else {
        inspection = tryInspectSqliteReadOnlyInProcess(input.pathname, inspect)?.value;
      }
      send({
        requestId,
        ok: true,
        inspection: null,
        stateInspection: inspection
          ? {
              ...inspection,
              inspectionErrors: inspection.inspectionErrors.map(
                serializeAgentSchemaInspectionError,
              ),
            }
          : null,
      });
      return;
    }
    const { input, snapshot } = request;
    if (input.env) {
      input.env = cloneEnvWithPlatformSemantics(input.env);
    }
    if (request.databaseEngineSelection) {
      const agentId = input.agentId;
      if (!agentId) {
        throw new Error("PostgreSQL schema inspection requires an established agent owner");
      }
      // Inspection establishes runtime admission, so it cannot borrow a runtime writer.
      const inspected = withDatabaseEngineSelection(request.databaseEngineSelection, () =>
        withEngineStoreAdmission(() =>
          withFreshOpenClawAgentDatabaseReadOnly(
            ({ db }) => ({
              version: readAgentDatabaseSchemaVersion(db),
              integrityGateOutcome: "healthy" as const,
              agentSchemaMeta: readExistingAgentSchemaMeta(db),
            }),
            { agentId, path: input.pathname, env: input.env },
          ),
        ),
      );
      send({ requestId, ok: true, inspection: inspected.found ? inspected.value : null });
      return;
    }
    // PostgreSQL inspection does not need the SQLite migration and integrity graph.
    const [{ inspectAgentDatabaseSchema }, { configureSqliteMaintenanceCache }] = await Promise.all(
      [
        import("./openclaw-agent-schema-inspection.js"),
        import("../infra/sqlite-maintenance-cache.js"),
      ],
    );
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
}

// SAFETY: Only the schema preflight owner sends this private IPC input.
process.on("message", (request: InspectionRequest | { type: "close" }) => {
  if (request.type === "close") {
    disconnect();
    return;
  }
  void inspectRequest(request);
});
