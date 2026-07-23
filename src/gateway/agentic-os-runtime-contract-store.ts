import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const SNAPSHOT_KEY = "agentic-os-runtime-contract-v1";
type RuntimeSnapshotDatabase = Pick<OpenClawStateKyselyDatabase, "agentic_os_runtime_snapshots">;

type AgenticOsRuntimeSnapshot = {
  leases: unknown[];
  releaseReplays: unknown[];
  sessions: unknown[];
};

export function runtimeSnapshotPath(): string {
  return resolveOpenClawStateSqlitePath(process.env);
}

export function loadAgenticOsRuntimeSnapshot(): AgenticOsRuntimeSnapshot | undefined {
  const database = openOpenClawStateDatabase();
  const row = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<RuntimeSnapshotDatabase>(database.db)
      .selectFrom("agentic_os_runtime_snapshots")
      .select("payload_json")
      .where("key", "=", SNAPSHOT_KEY),
  ).rows[0];
  return typeof row?.payload_json === "string"
    ? (JSON.parse(row.payload_json) as AgenticOsRuntimeSnapshot)
    : undefined;
}

export function saveAgenticOsRuntimeSnapshot(snapshot: AgenticOsRuntimeSnapshot): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      executeSqliteQuerySync(
        database.db,
        getNodeSqliteKysely<RuntimeSnapshotDatabase>(database.db)
          .insertInto("agentic_os_runtime_snapshots")
          .values({
            key: SNAPSHOT_KEY,
            payload_json: JSON.stringify(snapshot),
            updated_at_ms: Date.now(),
          })
          .onConflict((oc) =>
            oc.column("key").doUpdateSet((eb) => ({
              payload_json: eb.ref("excluded.payload_json"),
              updated_at_ms: eb.ref("excluded.updated_at_ms"),
            })),
          ),
      );
    },
    {},
    { operationLabel: "agentic-os-runtime-contract.snapshot.save" },
  );
}
