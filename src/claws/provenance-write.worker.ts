import { stableStringify } from "@openclaw/normalization-core";
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
import {
  CLAW_MCP_REF_SCHEMA_VERSION,
  rowToRef,
  selectMcpRefs,
  type PersistedClawMcpServerRef,
} from "./mcp-records.js";
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
  "clawProvenance.recoverMcp": (
    input: {
      agentId: string;
      name: string;
      action: "complete" | "release";
      expectedRefs: PersistedClawMcpServerRef[];
      agentLease: OpenClawStateLeaseIdentity;
      mcpLease: OpenClawStateLeaseIdentity;
      nowMs?: number;
    },
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const assertLeases = () => {
          verifyOpenClawStateLeaseOwnership({
            ...input.agentLease,
            leaseLabel: "Claw MCP recovery agent",
            transaction: db,
          });
          verifyOpenClawStateLeaseOwnership({
            ...input.mcpLease,
            leaseLabel: "Claw MCP lifecycle",
            transaction: db,
          });
        };
        assertLeases();
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        assertLeases();
        const rows = executeSqliteQuerySync(
          db,
          selectMcpRefs(db).where("name", "=", input.name).orderBy("agent_id"),
        ).rows;
        const refs = rows.map(rowToRef);
        const target = refs.find((ref) => ref.agentId === input.agentId);
        if (
          rows.some((row) => row.schema_version !== CLAW_MCP_REF_SCHEMA_VERSION) ||
          stableStringify(refs) !== stableStringify(input.expectedRefs) ||
          target?.status !== "pending"
        ) {
          throw new Error("Claw MCP ownership changed before recovery; preview again.");
        }
        const nowMs = input.nowMs ?? Date.now();
        const change =
          input.action === "complete"
            ? executeSqliteQuerySync(
                db,
                getNodeSqliteKysely<DB>(db)
                  .updateTable("claw_mcp_server_refs")
                  .set({ status: "complete", error: null, updated_at_ms: nowMs })
                  .where("agent_id", "=", input.agentId)
                  .where("name", "=", input.name)
                  .where("status", "=", "pending"),
              )
            : executeSqliteQuerySync(
                db,
                getNodeSqliteKysely<DB>(db)
                  .deleteFrom("claw_mcp_server_refs")
                  .where("agent_id", "=", input.agentId)
                  .where("name", "=", input.name)
                  .where("status", "=", "pending"),
              );
        if (change.numAffectedRows !== 1n) {
          throw new Error("Claw MCP ownership changed during recovery; preview again.");
        }
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        assertLeases();
        return {
          agentId: input.agentId,
          name: input.name,
          action: input.action,
          updatedAtMs: nowMs,
        };
      },
      { database: open(), ...stateOptions() },
    ),
} satisfies WorkerOperationHandlers;
