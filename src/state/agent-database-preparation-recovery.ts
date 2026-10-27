import {
  listAgentDatabaseAdmissionRefusals,
  readAgentDatabaseAdmissionRefusal,
} from "./agent-database-admission.js";
import { waitForAgentDatabasePreparation } from "./agent-database-preparation-context.js";

export type AgentRecoveryProgress<T = void> = {
  initial: Promise<void>;
  pending: ReadonlyMap<string, Promise<void>>;
  settled: Promise<T>;
};

/** Recover admitted stores, then rediscover skipped stores on their admission completion. */
export function recoverAfterAgentDatabasePreparation(
  signal: AbortSignal,
  recover: (agentIds?: ReadonlySet<string>) => Promise<void>,
): AgentRecoveryProgress {
  const pendingAgents = listAgentDatabaseAdmissionRefusals()
    .filter((refusal) => refusal.code === "agent-database-inspection-pending")
    .map((refusal) => refusal.agentId);
  const initial = Promise.resolve().then(() => recover());
  const pending = new Map(
    pendingAgents.map((agentId) => [
      agentId,
      initial.then(async () => {
        await waitForAgentDatabasePreparation(agentId, { signal });
        signal.throwIfAborted();
        if (!readAgentDatabaseAdmissionRefusal(agentId)) {
          await recover(new Set([agentId]));
        }
      }),
    ]),
  );
  const settled = Promise.allSettled([initial, ...pending.values()]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  });
  return { initial, pending, settled };
}
