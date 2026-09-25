import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { isCronRunReceiptOwnerStale } from "./run-receipt-store.js";

/** A serving process cannot attest drainage while another receipt owner remains active. */
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
  return reply.owners.some((owner) => {
    if (owner.ownerPid === process.pid) {
      // A retired writer can leave a running row after its core settles. The receipt
      // owner retains local liveness until that settlement or its safe finish retry.
      return !isCronRunReceiptOwnerStale(owner);
    }
    if (isPidDefinitelyDead(owner.ownerPid)) {
      return false;
    }
    const startedAt = getFileLockProcessStartTime(owner.ownerPid);
    // Unlike scheduling recovery, cleanup cannot use age to dismiss an unverifiable owner.
    return (
      owner.ownerStartTime === null || startedAt === null || owner.ownerStartTime === startedAt
    );
  });
}
