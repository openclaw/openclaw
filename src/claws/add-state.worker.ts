import { mergeWorkspaceSetupStateInDatabase } from "../agents/workspace-state-store.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { readAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import { recordAgentProvenance } from "../state/agent-provenance.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { ClawAddStateCommand } from "./add-state-worker-contract.js";
import { persistClawCronPendingRef, updateClawCronRef } from "./cron.js";
import { persistClawMcpPendingRef, updateClawMcpRef } from "./mcp.js";
import {
  deleteClawInstallRecord,
  persistClawInstallRecord,
  persistClawPackageRef,
  updateClawInstallRecordStatus,
  updateClawPackageRefStatus,
} from "./provenance.js";
import { persistClawWorkspaceFile, updateClawWorkspaceFileStatus } from "./workspace.js";

/** One finite Claw Add state change runs entirely on the shared SQLite actor. */
export function executeClawAddStateCommand(
  command: ClawAddStateCommand,
  database: OpenClawStateDatabase,
) {
  return runOpenClawStateWriteTransaction(
    () => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = (() => {
        switch (command.type) {
          case "claws.add.persistInstall": {
            if (
              readAgentDeletionJournalInDatabase(
                database,
                command.input.plan.agent.finalId,
                "runtime",
              )
            ) {
              throw new Error("Claw add is blocked by agent deletion recovery.");
            }
            return persistClawInstallRecord(command.input.plan, {
              database,
              status: command.input.status,
              nowMs: command.input.nowMs,
              expectedExistingRecord: command.input.expectedExistingRecord,
              expectedExistingPlan: command.input.expectedExistingPlan,
              deferLegacyPlanUpgrade: command.input.deferLegacyPlanUpgrade,
            });
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
      return result;
    },
    { database },
  );
}
