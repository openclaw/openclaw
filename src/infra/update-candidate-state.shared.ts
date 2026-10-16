import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  resolveOpenClawRegisteredAgentDatabasePath,
  resolveOpenClawStateDirForDatabasePath,
} from "../state/openclaw-state-db.paths.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import type { EngineConnection } from "./sql-connection.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import {
  queueStateDatabaseSpelling,
  type StateDatabaseDiscovery,
} from "./update-candidate-paths.js";
import type { UpdateCandidateBundledSource } from "./update-candidate-plugins.js";
export type StateInput = {
  stateDir: string;
  additionalPaths?: readonly string[];
  config: OpenClawConfigWithLegacyRoster;
  includeLocalStoreVersions?: boolean;
  env?: NodeJS.ProcessEnv;
  includeRetainedAgentPaths?: true;
  sourceBundledPlugins?: UpdateCandidateBundledSource;
};
type CandidateStateDatabase = Pick<
  DB,
  "agent_databases" | "agent_database_leases" | "state_leases"
>;
export function collectRegisteredPaths(
  db: EngineConnection,
  shared: string,
  files: Map<string, StateDatabaseDiscovery>,
) {
  // Raw registries can predate agent IDs; keep their paths without inventing ownership.
  const rows = tableExists(db, "agent_databases")
    ? executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<CandidateStateDatabase>(db)
          .selectFrom("agent_databases")
          .select("path")
          .select((eb) =>
            tableHasColumn(db, "agent_databases", "agent_id")
              ? eb.ref("agent_id").as("agent_id")
              : eb.val(null).as("agent_id"),
          )
          .orderBy("path"),
      ).rows
    : [];
  return rows.map(({ path: stored, agent_id: agentId }) => {
    const source = resolveOpenClawRegisteredAgentDatabasePath(shared, stored);
    // Discover registrations from the exact private generation being inspected.
    // Spellings dedupe on one projection identity per database, but every raw
    // alias stays queued: released workers reported them all, and released
    // rollback baselines compare exact paths against the versions response.
    queueStateDatabaseSpelling(
      files,
      resolveOpenClawStateDirForDatabasePath(shared),
      source,
      typeof agentId === "string" && agentId.length > 0 ? { role: "agent", agentId } : undefined,
      stored,
    );
    return { stored, source, agentId };
  });
}

export async function readSharedDatabaseVersion(
  location: string,
  shared: string,
  files: Map<string, StateDatabaseDiscovery>,
  input: StateInput,
) {
  const db = openNodeSqliteDatabase(location, { readOnly: true });
  try {
    const registered = collectRegisteredPaths(db, shared, files);
    let held: string[] = [];
    if (input.includeRetainedAgentPaths) {
      const { readUpdateHeldAgentPaths } = await import("./update-candidate-state.retained.js");
      held = readUpdateHeldAgentPaths(db, shared, files.values(), registered, input);
    }
    return {
      userVersion: readSqliteUserVersion(db),
      contentVersion: readStateSchemaContentVersion(db),
      ...(held.length ? { retainedAgentPaths: held } : {}),
    };
  } finally {
    db.close();
  }
}
