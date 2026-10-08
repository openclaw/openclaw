import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { AgentDeletionWorkerGuard } from "../state/agent-deletion-worker-contract.js";
import { assertAgentDeletionWorkerPredicate } from "../state/agent-deletion.worker.js";
import {
  CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE,
  clawPackageLifecycleLeaseKey,
} from "../state/claw-package-lifecycle-lease-key.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  assertOpenClawStateLeaseWorkerOwnedInTransaction,
  assertOpenClawStateLeasesWorkerOwnedInTransaction,
} from "../state/openclaw-state-lease-worker.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import { rowToRef, selectMcpRefs } from "./mcp-records.js";
import type {
  ClawPackageRefStatus,
  PersistedClawPackageRef,
} from "./package-extension-provenance.js";
import { updateClawPackageRefStatusInDatabase } from "./package-status.kernel.js";
import {
  readClawInstallRecordFromDatabase,
  readClawOrphanWorkspaceInDatabase,
} from "./provenance-read.kernel.js";

export const clawProvenanceOperations = {
  "clawProvenance.packageStatus": (
    input: {
      ref: PersistedClawPackageRef;
      status: ClawPackageRefStatus;
      nowMs?: number;
      lease: OpenClawStateLeaseIdentity;
      deletion?: AgentDeletionWorkerGuard;
    },
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      (database) => {
        const { db } = database;
        const ref = input.ref;
        const artifact =
          ref.kind === "plugin"
            ? { kind: ref.kind, source: ref.source, ref: ref.ref }
            : {
                kind: ref.kind,
                source: ref.source,
                ref: ref.ref,
                workspace:
                  readClawInstallRecordFromDatabase(db, ref.agentId)?.workspace ??
                  readClawOrphanWorkspaceInDatabase(db, ref.agentId)?.workspace ??
                  "",
              };
        if (
          (artifact.kind === "skill" && !artifact.workspace) ||
          input.lease.scope !== CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE ||
          input.lease.key !== clawPackageLifecycleLeaseKey(artifact)
        ) {
          throw new Error("Claw package claim does not match the held artifact lease");
        }
        const assertLeases = (stage: "transaction" | "commit") => {
          if (input.deletion) {
            if (
              input.deletion.predicate.agentId !== ref.agentId ||
              input.deletion.lease.scope !== "core:agent-deletion" ||
              input.deletion.lease.key !== ref.agentId
            ) {
              throw new Error("Claw package write does not belong to its deletion");
            }
            assertOpenClawStateLeasesWorkerOwnedInTransaction(
              db,
              [input.deletion.lease, input.lease],
              stage,
            );
            assertAgentDeletionWorkerPredicate(database, input.deletion.predicate);
          } else {
            assertOpenClawStateLeaseWorkerOwnedInTransaction(db, input.lease, "write", stage);
          }
        };
        assertLeases("transaction");
        const row = executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<DB>(db)
            .selectFrom("claw_package_refs")
            .select(["relationship", "origin", "independent_owner", "package_integrity"])
            .where("agent_id", "=", ref.agentId)
            .where("package_kind", "=", ref.kind)
            .where("package_source", "=", ref.source)
            .where("package_ref", "=", ref.ref)
            .where("package_version", "=", ref.version),
        );
        if (
          !row ||
          row.package_integrity !== ref.integrity ||
          row.relationship !== ref.relationship ||
          row.origin !== ref.origin ||
          Boolean(row.independent_owner) !== ref.independentOwner
        ) {
          throw new Error(
            `Package ${ref.ref}@${ref.version} ownership changed before its status write.`,
          );
        }
        const result = updateClawPackageRefStatusInDatabase(
          db,
          ref,
          input.status,
          input.nowMs ?? Date.now(),
        );
        assertLeases("commit");
        return result;
      },
      { database: open(), ...stateOptions() },
    ),
  "clawProvenance.reconcileMcp": (
    input: { agentId: string; digests: Record<string, string>; nowMs?: number },
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const refs = executeSqliteQuerySync(
          db,
          selectMcpRefs(db).where("agent_id", "=", input.agentId).orderBy("name"),
        ).rows.map(rowToRef);
        for (const ref of refs) {
          if (ref.status !== "pending" || input.digests[ref.name] !== ref.configDigest) {
            continue;
          }
          const updatedAtMs = input.nowMs ?? Date.now();
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<DB>(db)
              .updateTable("claw_mcp_server_refs")
              .set({ status: "complete", error: null, updated_at_ms: updatedAtMs })
              .where("agent_id", "=", ref.agentId)
              .where("name", "=", ref.name),
          );
          ref.status = "complete";
          ref.updatedAtMs = updatedAtMs;
          delete ref.error;
        }
        return refs;
      },
      { database: open(), ...stateOptions() },
    ),
} satisfies WorkerOperationHandlers;
