import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import {
  importLegacyMemberQueuedSource,
  type LegacyOpenClawIdMemberRoleImport,
} from "../openclaw-id/member-source-role-import.js";
import { decodeQueuedOperatorRecoverySource } from "../operator-run-recovery-source.codec.js";
import { queryWorkerEnvironmentStore } from "./store-row-codec.js";
import { executeWorkerEnvironmentWrite } from "./store-write.js";

/** Keep provisioning state and its live inventory under the environment mutation owner. */
export function importLegacyEnvironmentMemberSources(
  db: EngineConnection,
  input: LegacyOpenClawIdMemberRoleImport,
  touch: (id: string) => void,
): void {
  const stateDb = queryWorkerEnvironmentStore(db);
  const rows = executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("worker_environments")
      .select(["environment_id", "provision_source_json"])
      .where("provision_source_json", "is not", null),
  ).rows;
  for (const row of rows) {
    let source;
    try {
      const raw: unknown = JSON.parse(row.provision_source_json!);
      source = decodeQueuedOperatorRecoverySource(raw);
      if (!isDeepStrictEqual(raw, source)) {
        continue;
      }
    } catch {
      continue;
    }
    const next = importLegacyMemberQueuedSource(source, input);
    if (next === source) {
      continue;
    }
    executeWorkerEnvironmentWrite(
      db,
      stateDb
        .updateTable("worker_environments")
        .set({ provision_source_json: JSON.stringify(next) })
        .where("environment_id", "=", row.environment_id),
    );
    touch(row.environment_id);
  }
}
