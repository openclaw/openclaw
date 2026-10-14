import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type {
  ClawPackageRefStatus,
  PersistedClawPackageRef,
} from "./package-extension-provenance.js";

export function updateClawPackageRefStatusInDatabase(
  db: DatabaseSync,
  ref: PersistedClawPackageRef,
  status: ClawPackageRefStatus,
  nowMs: number,
): PersistedClawPackageRef {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "claw_package_refs">>(db)
      .updateTable("claw_package_refs")
      .set({ package_status: status, updated_at_ms: nowMs })
      .where("agent_id", "=", ref.agentId)
      .where("package_kind", "=", ref.kind)
      .where("package_source", "=", ref.source)
      .where("package_ref", "=", ref.ref)
      .where("package_version", "=", ref.version)
      .where("package_integrity", "=", ref.integrity),
  );
  return { ...ref, status, updatedAtMs: nowMs };
}
