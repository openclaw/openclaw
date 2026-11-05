import type { QueuedOperatorRecoverySource } from "../../gateway/operator-run-recovery-source.codec.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { SessionEntry } from "./types.js";

/** An admitted pursuit's custody, not permission and not a second work queue. */
export type SessionGoalSuccessor = {
  version: 1;
  id: string;
  sessionId: string;
  lifecycleRevision?: string;
  goalId: string;
  sourceRunId: string;
  phase: "running" | "pending" | "children";
  childRunIds?: string[];
  source: QueuedOperatorRecoverySource;
  refusal?: string;
  toolsAllow?: string[][];
  settings: Pick<SessionEntry, "permissionMode" | "toolOverrides">;
  deliver: boolean;
  deliveryContext?: DeliveryContext;
  ownerContinuation: boolean;
  requiresWorker: boolean;
};
