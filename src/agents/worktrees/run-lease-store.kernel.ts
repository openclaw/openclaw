import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { worktreeRunLeaseScope } from "./run-lease-owner.js";

export function releaseWorktreeRunLeaseInDatabase(
  db: DatabaseSync,
  worktreeId: string,
  token: string,
): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
      .deleteFrom("state_leases")
      .where("scope", "=", worktreeRunLeaseScope(worktreeId))
      .where("lease_key", "=", token),
  );
}
