import { mergeWorkspaceSetupStateInDatabase } from "../agents/workspace-state-store.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  claimCompletedAgentDeletionJournal,
  readAgentDeletionJournalInDatabase,
} from "../state/agent-deletion-journal.js";
import { recordAgentProvenance } from "../state/agent-provenance.js";
import { clawPackageLifecycleLeaseKey } from "../state/claw-package-lifecycle-lease.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { readOpenClawStateLeaseExpiry } from "../state/openclaw-state-lease-store.js";
import type { ClawAddStateCommand } from "./add-state-worker-contract.js";
import { persistClawCronPendingRef, updateClawCronRef } from "./cron.js";
import { persistClawMcpPendingRef, updateClawMcpRef } from "./mcp.js";
import {
  deleteClawInstallRecord,
  persistClawInstallRecord,
  persistClawPackageRef,
  readClawInstallRecordFromDatabase,
  updateClawInstallRecordStatus,
  updateClawPackageRefStatus,
} from "./provenance.js";
import { persistClawWorkspaceFile, updateClawWorkspaceFileStatus } from "./workspace.js";

function assertPackageLease(command: ClawAddStateCommand, database: OpenClawStateDatabase): void {
  if (
    command.type !== "claws.add.persistPackageRef" &&
    command.type !== "claws.add.updatePackageRefStatus"
  ) {
    return;
  }
  const agentId =
    command.type === "claws.add.persistPackageRef"
      ? command.input.plan.agent.finalId
      : command.input.ref.agentId;
  const install = readClawInstallRecordFromDatabase(database.db, agentId);
  const pkg =
    command.type === "claws.add.persistPackageRef" ? command.input.pkg : command.input.ref;
  const packageLease = command.input.packageLease;
  if (
    !install ||
    (command.type === "claws.add.persistPackageRef" &&
      install.workspace !== command.input.plan.agent.workspace)
  ) {
    throw new Error("Claw package reference no longer has its planned install owner.");
  }
  const key = clawPackageLifecycleLeaseKey(
    pkg.kind === "skill"
      ? { kind: "skill", source: pkg.source, ref: pkg.ref, workspace: install.workspace }
      : { kind: "plugin", source: pkg.source, ref: pkg.ref },
  );
  if (
    packageLease.scope !== "claw-package-lifecycle" ||
    packageLease.key !== key ||
    readOpenClawStateLeaseExpiry(database.db, packageLease) === undefined
  ) {
    throw new Error("Claw package reference no longer owns its package lifecycle lease.");
  }
}

/** One finite Claw Add state change runs entirely on the shared SQLite actor. */
export function executeClawAddStateCommand(
  command: ClawAddStateCommand,
  database: OpenClawStateDatabase,
) {
  return runOpenClawStateWriteTransaction(
    () => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      assertPackageLease(command, database);
      const result = (() => {
        switch (command.type) {
          case "claws.add.persistInstall": {
            const deletion = readAgentDeletionJournalInDatabase(
              database,
              command.input.plan.agent.finalId,
              "runtime",
            );
            if (deletion && !deletion.cleanupCompleted) {
              throw new Error("Claw add is blocked by agent deletion recovery.");
            }
            const install = persistClawInstallRecord(command.input.plan, {
              database,
              status: command.input.status,
              nowMs: command.input.nowMs,
              expectedExistingRecord: command.input.expectedExistingRecord,
              expectedExistingPlan: command.input.expectedExistingPlan,
              deferLegacyPlanUpgrade: command.input.deferLegacyPlanUpgrade,
            });
            return {
              install,
              ...(deletion ? { completedDeletionOperationId: deletion.operationId } : {}),
            };
          }
          case "claws.add.claimCompletedDeletion": {
            const { agentId, operationId } = command.input;
            const deletion = readAgentDeletionJournalInDatabase(database, agentId, "runtime");
            if (
              deletion?.operationId !== operationId ||
              !deletion.cleanupCompleted ||
              !claimCompletedAgentDeletionJournal(agentId, operationId, { database })
            ) {
              throw new Error("Completed agent deletion changed during Claw add.");
            }
            return;
          }
          case "claws.add.updateInstallStatus":
            return updateClawInstallRecordStatus(command.input.agentId, command.input.status, {
              database,
              nowMs: command.input.nowMs,
              expectedStatuses: command.input.expectedStatuses,
            });
          case "claws.add.deleteInstall":
            return deleteClawInstallRecord(command.input.agentId, {
              database,
              expectedStatuses: command.input.expectedStatuses,
            });
          case "claws.add.recordAgentProvenance":
            return recordAgentProvenance(command.input.agentId, command.input.provenance, {
              database,
              nowMs: command.input.nowMs,
            });
          case "claws.add.persistPackageRef":
            return persistClawPackageRef(command.input.plan, command.input.pkg, {
              database,
              nowMs: command.input.nowMs,
              status: command.input.status,
              relationship: command.input.relationship,
              origin: command.input.origin,
              independentOwner: command.input.independentOwner,
            });
          case "claws.add.updatePackageRefStatus":
            return updateClawPackageRefStatus(command.input.ref, command.input.status, {
              database,
              nowMs: command.input.nowMs,
            });
          case "claws.add.persistWorkspaceFile":
            return persistClawWorkspaceFile(command.input.record, { database });
          case "claws.add.updateWorkspaceFileStatus":
            return updateClawWorkspaceFileStatus(
              command.input.record,
              command.input.expectedStatuses,
              { database },
            );
          case "claws.add.persistMcpPendingRef":
            return persistClawMcpPendingRef(
              command.input.plan,
              command.input.name,
              command.input.server,
              command.input.ownership,
              { database, nowMs: command.input.nowMs },
            );
          case "claws.add.updateMcpRef":
            return updateClawMcpRef(command.input.ref, command.input.update, {
              database,
              nowMs: command.input.nowMs,
            });
          case "claws.add.persistCronPendingRef":
            return persistClawCronPendingRef(command.input.plan, command.input.job, {
              database,
              nowMs: command.input.nowMs,
            });
          case "claws.add.updateCronRef":
            return updateClawCronRef(command.input.ref, command.input.update, {
              database,
              nowMs: command.input.nowMs,
            });
          case "claws.add.mergeBootstrapSetupState":
            return mergeWorkspaceSetupStateInDatabase(
              command.input.workspaceDir,
              { bootstrapSeededAt: command.input.bootstrapSeededAt },
              command.input.nowMs,
              database,
            );
        }
      })();
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      assertPackageLease(command, database);
      return result;
    },
    { database },
  );
}
