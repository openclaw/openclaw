import type { AgentDeletionWorkerWriteFacts } from "../state/agent-deletion-journal.types.js";

/** Original Claw custody consumed inside Cron's native deletion transaction. */
export type ClawPortableRemovalPrecondition = {
  agentId: string;
  jobId: string;
  configRevision: string;
  expectedStateDigest: string;
  expectedInstallDigest: string;
  deletion: AgentDeletionWorkerWriteFacts;
};
