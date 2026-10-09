import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE,
  clawPackageLifecycleLeaseKey,
} from "../state/claw-package-lifecycle-lease-key.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "../state/openclaw-state-lease-worker.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import { rowToRef, selectMcpRefs } from "./mcp-records.js";
import { updateClawPackageRefStatusInDatabase } from "./package-status.kernel.js";
import {
  readClawInstallRecordFromDatabase,
  readClawOrphanWorkspaceInDatabase,
} from "./provenance-read.kernel.js";
import type { ClawProvenanceWriteOperations } from "./provenance-write.worker-contract.js";
import { mutateClawRemovalJournalInWorker } from "./removal-journal.worker.js";

export const clawProvenanceOperations = {
  "clawProvenance.removalJournal": (
    input: ClawProvenanceWriteOperations["clawProvenance.removalJournal"]["input"],
    { open, stateOptions },
  ) => mutateClawRemovalJournalInWorker(open(), input, stateOptions()),
  "clawProvenance.packageStatus": (
    input: ClawProvenanceWriteOperations["clawProvenance.packageStatus"]["input"],
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
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
        assertOpenClawStateLeaseWorkerOwnedInTransaction(db, input.lease);
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
        assertOpenClawStateLeaseWorkerOwnedInTransaction(db, input.lease, "write", "commit");
        return result;
      },
      { database: open(), ...stateOptions() },
    ),
  "clawProvenance.reconcileMcp": (
    input: ClawProvenanceWriteOperations["clawProvenance.reconcileMcp"]["input"],
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
