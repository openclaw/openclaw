import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";

export function describeUnavailableCronAgent(agentId: string, env?: NodeJS.ProcessEnv): string {
  const refusal = readAgentDatabaseAdmissionRefusal(agentId, { env });
  return refusal
    ? `${refusal.reason}\n${refusal.repairHint}`
    : `cron job agent is unavailable: ${agentId}`;
}
