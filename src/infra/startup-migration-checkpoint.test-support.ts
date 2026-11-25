import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  parseStateLeaseProcessOwner,
  readStateLeaseProcessOwnerStatus,
} from "./state-lease-process-owner.js";

/** Inspect lease settlement in isolated fixtures, never in a restart observer. */
export function hasActiveStartupMigrationLeaseForTest({
  env = process.env,
  nowMs = Date.now(),
}: { env?: NodeJS.ProcessEnv; nowMs?: number } = {}): boolean {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => {
        const lease = executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<DB>(db)
            .selectFrom("state_leases")
            .select("payload_json as payloadJson")
            .where("scope", "=", "startup-migrations")
            .where("lease_key", "=", "global")
            .where("expires_at", ">", nowMs),
        );
        return Boolean(
          lease &&
          readStateLeaseProcessOwnerStatus(parseStateLeaseProcessOwner(lease.payloadJson)) !==
            "dead",
        );
      },
      { env },
    ) ?? false
  );
}
