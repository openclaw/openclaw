import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { OperatorApprovalDatabase } from "./operator-approval-store.types.js";

/**
 * Delete resolved approvals older than the retention cutoff.
 * The minting approval is the grant's authorization owner, so keep it while
 * an unrevoked grant names it and that grant has no expiry or an expiry still
 * in the future. A missing table means no grant can exist.
 */
export function deleteTerminalOperatorApprovalsPastRetention(params: {
  db: EngineConnection;
  cutoffMs: number;
  nowMs: number;
}): string[] {
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(params.db);
  let query = stateDb
    .deleteFrom("operator_approvals")
    .where("status", "!=", "pending")
    .where("resolved_at_ms", "is not", null)
    .where("resolved_at_ms", "<=", params.cutoffMs);
  if (tableExists(params.db, "operator_approval_standing_grants")) {
    query = query.where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("operator_approval_standing_grants")
            .select("grant_id")
            .whereRef("minted_by_approval_id", "=", "operator_approvals.approval_id")
            .where("revoked_at_ms", "is", null)
            .where((grant) =>
              grant.or([
                grant("expires_at_ms", "is", null),
                grant("expires_at_ms", ">", params.nowMs),
              ]),
            ),
        ),
      ),
    );
  }
  return executeSqliteQuerySync(params.db, query.returning("approval_id")).rows.map(
    (row) => row.approval_id,
  );
}
