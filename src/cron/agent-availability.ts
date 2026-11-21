import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";

/** Transaction facts travel from the worker; resident configuration stays with the host. */
type CronAgentAvailabilityFacts = { deletionBlocked: boolean };
export type CronAgentAvailability = (agentId: string, facts: CronAgentAvailabilityFacts) => boolean;

/** Deletion owns this refusal. */
export class CronAgentDeletionBlockedError extends Error {
  constructor(agentId: string) {
    super(describeUnavailableCronAgent(agentId));
    this.name = "CronAgentDeletionBlockedError";
  }
}

export function describeUnavailableCronAgent(agentId: string, env?: NodeJS.ProcessEnv): string {
  const refusal = readAgentDatabaseAdmissionRefusal(agentId, { env });
  return refusal
    ? `${refusal.reason}\n${refusal.repairHint}`
    : `cron job agent is unavailable: ${agentId}`;
}
