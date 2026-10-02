import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { deleteClawCronRef, upsertClawCronRef } from "./cron.js";
import { deleteClawMcpServerRef, upsertClawMcpServerRef } from "./mcp.js";
import { replaceClawPackageRefExpected } from "./package-update-provenance.js";
import { updateClawInstallRecord } from "./provenance.js";
import type { ClawUpdateStateCommand } from "./update-state-worker-contract.js";
import { deleteClawWorkspaceFileRecord, upsertClawWorkspaceFile } from "./workspace.js";

export function executeClawUpdateStateCommand(
  command: ClawUpdateStateCommand,
  database: OpenClawStateDatabase,
) {
  return runOpenClawStateWriteTransaction(
    () => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = (() => {
        switch (command.type) {
          case "claws.update.replacePackageRef":
            return replaceClawPackageRefExpected(
              command.input.expected,
              command.input.replacement,
              { database },
            );
          case "claws.update.upsertWorkspaceFile":
            return upsertClawWorkspaceFile(command.input.record, { database });
          case "claws.update.deleteWorkspaceFile":
            return deleteClawWorkspaceFileRecord(command.input.agentId, command.input.path, {
              database,
            });
          case "claws.update.upsertMcpRef":
            return upsertClawMcpServerRef(command.input.record, { database });
          case "claws.update.deleteMcpRef":
            return deleteClawMcpServerRef(command.input.agentId, command.input.name, { database });
          case "claws.update.upsertCronRef":
            return upsertClawCronRef(command.input.record, { database });
          case "claws.update.deleteCronRef":
            return deleteClawCronRef(command.input.agentId, command.input.manifestId, { database });
          case "claws.update.persistInstall":
            return updateClawInstallRecord(command.input.plan, {
              database,
              nowMs: command.input.nowMs,
              expectedClaw: command.input.expectedClaw,
              status: command.input.status,
              agentConfigDigest: command.input.agentConfigDigest,
            });
        }
      })();
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    },
    { database },
  );
}
