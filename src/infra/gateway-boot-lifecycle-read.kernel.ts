// Boot-history reads, isolated from the writer so the shared-state read worker
// can serve them without loading the gateway lifecycle module's write path.
import type { DatabaseSync } from "node:sqlite";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

/** One persisted gateway lifetime, as needed to attribute orphaned work. */
export type GatewayBootLifecycleSegment = {
  bootId: string;
  pid: number;
  startedAtMs: number;
  completedAtMs: number | null;
  outcome: string | null;
  hostBootId: string | null;
};

// Ordinary diagnostics want the recent tail; attribution overrides this.
const GATEWAY_BOOT_LIFECYCLE_DEFAULT_READ_LIMIT = 64;

type GatewayBootLifecycleDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_boot_lifecycle">;

/**
 * Reads recent boot segments oldest-first. Callers correlate their own
 * timestamps against these rows; this function makes no judgement about them.
 */
export function readGatewayBootLifecycleSegmentsInDatabase(
  db: DatabaseSync,
  params?: { sinceMs?: number; limit?: number },
): GatewayBootLifecycleSegment[] {
  let query = getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db)
    .selectFrom("gateway_boot_lifecycle")
    .select([
      "boot_id as bootId",
      "pid",
      "started_at_ms as startedAtMs",
      "completed_at_ms as completedAtMs",
      "outcome",
      "host_boot_id as hostBootId",
    ])
    .orderBy("started_at_ms", "desc")
    .limit(params?.limit ?? GATEWAY_BOOT_LIFECYCLE_DEFAULT_READ_LIMIT);
  if (typeof params?.sinceMs === "number") {
    query = query.where("started_at_ms", ">=", params.sinceMs);
  }
  const { rows } = executeSqliteQuerySync(db, query);
  return rows.toSorted((left, right) => left.startedAtMs - right.startedAtMs);
}
