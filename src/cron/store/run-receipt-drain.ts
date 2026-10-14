import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";

/** Startup recovery clears abandoned requests before Gateway work is admitted. */
export async function hasActiveCronRunReceiptsForAgent(agentId: string): Promise<boolean> {
  const reply = await executeExistingOpenClawStateRead(
    {},
    { type: "cron.activeReceiptOwners", agentId },
    { current: true },
  );
  if (!reply) {
    return false;
  }
  if (!reply.ok || reply.type !== "cron.activeReceiptOwners") {
    throw new Error("Cron receipt owners are unavailable for drainage.");
  }
  return reply.owners.length > 0;
}
