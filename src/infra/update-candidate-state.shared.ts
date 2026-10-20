import fs from "node:fs/promises";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  resolveOpenClawRegisteredAgentDatabasePath,
  resolveOpenClawStateDirForDatabasePath,
} from "../state/openclaw-state-db.paths.js";
import { ignoreMissingPath } from "./errno.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import type { EngineConnection } from "./sql-connection.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import {
  queueStateDatabaseSpelling,
  resolveUpdateCandidateStateIdentity,
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

/** A fresh PostgreSQL anchor has header version zero; versioned SQLite needs no payload copy. */
export async function readUpdateStoreSchemaVersion(
  file: string,
  input: StateInput & { stagingRoot?: string; preserveSourceArtifacts?: boolean },
): Promise<{ userVersion: number }> {
  const { inspectSqliteSchemaHeaderInProcess } = await import("./sqlite-readonly-location.js");
  const { userVersion } = await inspectSqliteSchemaHeaderInProcess(
    file,
    input.stagingRoot,
    undefined,
    input.preserveSourceArtifacts,
  );
  if (userVersion === 0) {
    const { readBackupEngine } = await import("../snapshot/database-backup.js");
    if (readBackupEngine(file).engine === "postgres") {
      const { readUpdatePostgresStoreVersion } =
        await import("./update-candidate-state.postgres.js");
      return { userVersion: await readUpdatePostgresStoreVersion(input, file) };
    }
  }
  return { userVersion };
}

export async function collectSupplementalStateDatabasePaths(
  input: StateInput,
  files: Map<string, StateDatabaseDiscovery>,
) {
  const { discoverBackupDatabasePaths } = await import("./backup-sqlite-snapshot.js");
  const knownRealpaths = new Set(
    await Promise.all([...files.keys()].map((file) => fs.realpath(file).catch(ignoreMissingPath))),
  );
  // The private snapshot below owns registry reads, including legacy schemas.
  // Include declared retained plugin databases on either physical engine here.
  for (const file of input.additionalPaths ??
    (await discoverBackupDatabasePaths({ ...input, agentRegistry: [] }))) {
    // Supplemental realpaths must not add aliases to the legacy versions inventory.
    // Registry discovery below still preserves every explicitly recorded spelling.
    if (files.has(resolveUpdateCandidateStateIdentity(input.stateDir, file))) {
      continue;
    }
    const realpath = await fs.realpath(file).catch(ignoreMissingPath);
    if (realpath === undefined || !knownRealpaths.has(realpath)) {
      queueStateDatabaseSpelling(files, input.stateDir, file);
      if (realpath !== undefined) {
        knownRealpaths.add(realpath);
      }
    }
  }
  return files;
}
