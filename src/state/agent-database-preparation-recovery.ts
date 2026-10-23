import {
  listAgentDatabaseAdmissionRefusals,
  readAgentDatabaseAdmissionRefusal,
} from "./agent-database-admission.js";
import { waitForAgentDatabasePreparation } from "./agent-database-preparation-context.js";

/** Recover admitted stores, then rediscover skipped stores after their preparation settles. */
export async function recoverAfterAgentDatabasePreparation(
  signal: AbortSignal,
  recover: (agentIds?: ReadonlySet<string>) => Promise<void>,
): Promise<void> {
  const pendingAgents = listAgentDatabaseAdmissionRefusals()
    .filter((refusal) => refusal.code === "agent-database-inspection-pending")
    .map((refusal) => refusal.agentId);
  await recover();
  const rescans = await Promise.allSettled(
    pendingAgents.map(async (agentId) => {
      await waitForAgentDatabasePreparation(agentId, { signal });
      signal.throwIfAborted();
      if (!readAgentDatabaseAdmissionRefusal(agentId)) {
        await recover(new Set([agentId]));
      }
    }),
  );
  for (const result of rescans) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
}
