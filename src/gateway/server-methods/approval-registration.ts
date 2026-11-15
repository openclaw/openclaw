import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { ExecApprovalManager, ExecApprovalRecord } from "../exec-approval-manager.js";
import {
  captureWorkerTurnLiveEventOwner,
  type WorkerTurnLiveEventOwner,
} from "../worker-environments/worker-turn-run-owner.js";
import { respondApprovalStorageUnavailable } from "./approval-shared.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

/** Capture the validated requester before any approval preparation can yield. */
export function captureApprovalWorkerOwner(
  runtimeIdentity: AgentRuntimeIdentity | undefined,
): WorkerTurnLiveEventOwner | undefined {
  const delegated = runtimeIdentity?.delegatedAuthority;
  return delegated?.kind === "worker"
    ? captureWorkerTurnLiveEventOwner({
        sessionId: delegated.turnClaim.sessionId,
        turnClaim: delegated.turnClaim,
      })
    : undefined;
}

/** Registers an approval record and converts manager registration errors to gateway errors. */
export async function registerPendingApprovalRecord<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  record: ExecApprovalRecord<TPayload>;
  timeoutMs: number;
  respond: RespondFn;
  context: GatewayRequestContext;
  workerOwner?: WorkerTurnLiveEventOwner;
}): Promise<{ decision: Promise<ExecApprovalDecision | null> } | undefined> {
  try {
    const registration = await params.manager.register(params.record, params.timeoutMs);
    if (params.workerOwner && params.manager.isPending(params.record)) {
      const wait = params.workerOwner.beginApprovalWait(params.record.expiresAtMs, () =>
        params.manager.isPending(params.record),
      );
      if (wait) {
        // Decision, expiry and withdrawal settle this original registration.
        void registration.decision.then(
          () => wait.close(),
          () => wait.close(),
        );
      }
    }
    return registration;
  } catch (err) {
    respondApprovalStorageUnavailable({ ...params, operation: "request", error: err });
    return undefined;
  }
}
