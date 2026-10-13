import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { clawInstallRecordFromRow } from "../claws/provenance-read.kernel.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import type { AgentDeletionWorkerGuard } from "./agent-deletion-worker-contract.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "./openclaw-state-db-readonly.js";
import type { DB } from "./openclaw-state-db.generated.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { createOpenClawStateLeaseLostError } from "./openclaw-state-lease-error.js";
import {
  verifyOpenClawStateLeaseOwnership,
  type OpenClawStateLeaseOwnerIdentity,
} from "./openclaw-state-lease-storage.js";

/** Foreign package writers require a current read immediately before filesystem effects. */
export function assertAgentDeletionLeaseFinal(
  identity: OpenClawStateLeaseOwnerIdentity,
  options: OpenClawStateDatabaseOptions,
  assertCurrentHost: () => void,
): void {
  assertCurrentHost();
  const found = withExistingOpenClawStateDatabaseCurrentReadOnly(
    ({ db }) => {
      verifyOpenClawStateLeaseOwnership({ ...identity, transaction: db });
      return true;
    },
    { ...options, allowNativeRead: true },
  );
  if (!found) {
    throw createOpenClawStateLeaseLostError(identity);
  }
  assertCurrentHost();
}

/** The minted host owner surrounds this current point read; comparison fields alone grant nothing. */
export function assertAgentDeletionFinalInDatabase(
  database: DatabaseSync,
  guard: AgentDeletionWorkerGuard,
): void {
  const { lease, predicate } = guard;
  const db =
    getNodeSqliteKysely<Pick<DB, "state_leases" | "agent_deletion_journal" | "claw_installs">>(
      database,
    );
  const query = db
    .selectFrom("state_leases as lease")
    .leftJoin("agent_deletion_journal as journal", (join) =>
      join.on("journal.agent_id", "=", predicate.agentId),
    )
    .select([
      "lease.owner as leaseOwner",
      "lease.expires_at as leaseExpiresAt",
      "journal.operation_id as operationId",
      "journal.cleanup_completed as cleanupCompleted",
    ])
    .where("lease.scope", "=", lease.scope)
    .where("lease.lease_key", "=", lease.key);
  const assertLeaseAndJournal = (
    row:
      | {
          leaseOwner: string;
          leaseExpiresAt: number | null;
          operationId: string | null;
          cleanupCompleted: number | null;
        }
      | undefined,
  ) => {
    if (
      !row ||
      row.leaseOwner !== lease.owner ||
      row.leaseExpiresAt === null ||
      row.leaseExpiresAt <= Date.now()
    ) {
      throw createOpenClawStateLeaseLostError({ ...lease, leaseLabel: "agent deletion" });
    }
    if (row.operationId !== predicate.operationId || row.cleanupCompleted !== 0) {
      throw new Error(`Agent ${predicate.agentId} deletion no longer owns database cleanup.`);
    }
  };
  const changedInstall = () =>
    Object.assign(new Error(`Claw removal no longer owns agent ${predicate.agentId}.`), {
      code: "CLAW_INSTALL_CHANGED",
    });
  if (predicate.expectedClawInstall === undefined) {
    assertLeaseAndJournal(executeSqliteQueryTakeFirstSync(database, query));
    return;
  }
  if (getAdmittedSqliteSchemaFacts(database)?.tables.has("claw_installs") === false) {
    if (predicate.expectedClawInstall !== null) {
      throw changedInstall();
    }
    assertLeaseAndJournal(executeSqliteQueryTakeFirstSync(database, query));
    return;
  }
  if (predicate.expectedClawInstall === null) {
    const row = executeSqliteQueryTakeFirstSync(
      database,
      query
        .leftJoin("claw_installs as install", "install.agent_id", "journal.agent_id")
        .select("install.agent_id as installAgentId"),
    );
    assertLeaseAndJournal(row);
    if (row?.installAgentId != null) {
      throw changedInstall();
    }
    return;
  }
  const row = executeSqliteQueryTakeFirstSync(
    database,
    query
      .innerJoin("claw_installs as install", "install.agent_id", "journal.agent_id")
      .select([
        "install.agent_id",
        "install.schema_version",
        "install.source_kind",
        "install.claw_name",
        "install.claw_version",
        "install.package_root",
        "install.manifest_path",
        "install.integrity_kind",
        "install.integrity",
        "install.source_byte_length",
        "install.manifest_schema_version",
        "install.plan_integrity",
        "install.workspace",
        "install.agent_config_digest",
        "install.agent_owned_paths_json",
        "install.bootstrap_source_path",
        "install.bootstrap_content_digest",
        "install.status",
        "install.added_at_ms",
        "install.updated_at_ms",
      ]),
  );
  if (!row) {
    throw changedInstall();
  }
  assertLeaseAndJournal(row);
  if (!isDeepStrictEqual(clawInstallRecordFromRow(row), predicate.expectedClawInstall)) {
    throw changedInstall();
  }
}
