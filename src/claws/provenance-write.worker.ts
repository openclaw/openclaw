import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { verifyOpenClawStateLeaseOwnership } from "../state/openclaw-state-lease-storage.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import { rowToRef, selectMcpRefs } from "./mcp-records.js";
import type {
  ClawPackageRefStatus,
  PersistedClawPackageRef,
} from "./package-extension-provenance.js";
import { updateClawPackageRefStatusInDatabase } from "./package-status.kernel.js";

export const clawProvenanceOperations = {
  "clawProvenance.packageStatus": (
    input: {
      ref: PersistedClawPackageRef;
      status: ClawPackageRefStatus;
      nowMs?: number;
      lease: OpenClawStateLeaseIdentity;
    },
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const assertLease = () =>
          verifyOpenClawStateLeaseOwnership({
            ...input.lease,
            leaseLabel: "Claw package lifecycle",
            transaction: db,
          });
        assertLease();
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        assertLease();
        const ref = input.ref;
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
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        assertLease();
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
