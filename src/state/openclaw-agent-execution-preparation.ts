import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { takeSqliteWorkerOperationAdmissionAttachment } from "../infra/sqlite-worker-operation-admission.js";
import type { AgentDeletionWorkerGuard } from "./agent-deletion-worker-contract.js";

export function readAgentDatabaseRequestPreparation(): {
  startupJournal: boolean;
  deletion?: AgentDeletionWorkerGuard;
} {
  const attachment = takeSqliteWorkerOperationAdmissionAttachment();
  if (
    !isRecord(attachment) ||
    attachment.kind !== "agent-execution" ||
    typeof attachment.startupJournal !== "boolean"
  ) {
    throw new Error("Agent execution requires its request-local preparation facts");
  }
  return {
    startupJournal: attachment.startupJournal,
    // SAFETY: The host sends this typed guard; its live owner compares it before SQL.
    deletion: attachment.deletion as AgentDeletionWorkerGuard | undefined,
  };
}
