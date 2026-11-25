import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { readRetainedAgentDeletionsFromDatabase } from "./agent-deletion-journal.read.js";
import { readAgentDatabasePreflightTargets } from "./openclaw-agent-db-registry.read.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { inspectOpenClawStateOwnershipFromDatabase } from "./openclaw-state-ownership.js";
import type {
  StateSchemaInspection,
  StateSchemaInspectionInput,
} from "./openclaw-state-schema-preflight.js";

export const stateBootstrapReadOperations = {
  "stateBootstrap.ownership": (input: { pathname: string }, db: EngineConnection) => ({
    type: "stateBootstrap.ownership" as const,
    ownership: inspectOpenClawStateOwnershipFromDatabase(db, input.pathname),
  }),
  "stateBootstrap.inspect": (input: StateSchemaInspectionInput, db: EngineConnection) => {
    const facts = isPostgresSqlConnection(db) ? getPostgresPhysicalFacts(db) : undefined;
    if (!facts?.version) {
      throw new Error("PostgreSQL startup inspection requires an admitted state connection");
    }
    const { version, minReader } = facts;
    const requiredVersion =
      input.purpose === "runtime" && input.supportedVersion === OPENCLAW_STATE_SCHEMA_VERSION
        ? minReader
        : version;
    const inspection: StateSchemaInspection = {
      schemas: { incompatible: [], indeterminate: [] },
      inspectionErrors: [],
    };
    if (version < input.supportedVersion || requiredVersion > input.supportedVersion) {
      const versions =
        version < input.supportedVersion
          ? (inspection.schemas.pendingMigrations ??= [])
          : inspection.schemas.incompatible;
      versions.push({
        kind: "state",
        path: input.pathname,
        foundVersion: version,
        supportedVersion: input.supportedVersion,
      });
    }
    if (input.scope !== "state") {
      inspection.registeredDatabases = readAgentDatabasePreflightTargets(db, input.pathname);
      inspection.deletionJournal = readRetainedAgentDeletionsFromDatabase(
        db,
        input.pathname,
        input.purpose,
      );
    }
    return { type: "stateBootstrap.inspect" as const, inspection };
  },
};
