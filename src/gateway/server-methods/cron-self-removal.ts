import {
  assertCronSelfRemovalOwnerCurrent,
  bindCronSelfRemovalCommitGuard,
} from "../../cron/active-jobs.js";
import { readCronCallerScope, type CronCallerScope } from "./cron-caller-scope.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

/**
 * Binds the removal guard of a run that targets its own job. Only the exact live owner may
 * delete the job while it runs; any other self-targeted caller is refused before the durable
 * delete, so the removal never degrades into operator cancellation of that run.
 */
export function resolveCronRemovalCommitGuard(params: {
  client: GatewayClient | null;
  context: Pick<GatewayRequestContext, "validateAgentRuntimeApprovalAuthority">;
  callerScope: CronCallerScope | undefined;
  jobId: string;
  commitGuard: (() => void) | undefined;
}): (() => void) | undefined {
  const { client, context, callerScope, jobId, commitGuard } = params;
  const identity = client?.internal?.agentRuntimeIdentity;
  const validateAuthority = context.validateAgentRuntimeApprovalAuthority;
  if (!identity || !validateAuthority || !commitGuard || callerScope?.currentJobId !== jobId) {
    return commitGuard;
  }
  const selfRemovalGuard = () => {
    commitGuard();
    assertCronSelfRemovalOwnerCurrent(jobId, selfRemovalGuard);
  };
  bindCronSelfRemovalCommitGuard(jobId, identity.operationalRunInstance, selfRemovalGuard, () => {
    if (!validateAuthority(identity) || readCronCallerScope(client)?.currentJobId !== jobId) {
      throw new TypeError("cron self-removal authority is no longer active");
    }
  });
  return selfRemovalGuard;
}
