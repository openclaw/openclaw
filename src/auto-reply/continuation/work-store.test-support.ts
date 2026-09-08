import { createManagedTaskFlow } from "../../tasks/task-flow-runtime-internal.js";
import {
  CONTINUATION_WORK_CONTROLLER_ID,
  encodeWorkState,
  workGoal,
  workToRuntime,
  type PendingContinuationWork,
} from "./work-flow-state.js";

export function enqueuePendingWork(work: PendingContinuationWork): PendingContinuationWork | null {
  const state = encodeWorkState(work);
  const flow = createManagedTaskFlow({
    ownerKey: work.sessionKey,
    ...(work.chainId ? { chainId: work.chainId } : {}),
    controllerId: CONTINUATION_WORK_CONTROLLER_ID,
    notifyPolicy: "silent",
    goal: workGoal(work),
    currentStep: "Queued for same-session continuation wake",
    stateJson: state,
    createdAt: work.electedAt,
  });
  return flow ? workToRuntime(flow, state, "queued") : null;
}
