import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareOpenClawIdTunnelPrincipal } from "../../gateway/openclaw-id/tunnel-principal.js";
import { resolveCreatorSandbox } from "../../gateway/operator-role-policy.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../../infra/restart-recovery-errors.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import { cronExecutionActor } from "../human-owner.js";
import { CronOperatorSourceError } from "../operator-source-error.js";
import { readCronOperatorSnapshotForRun } from "../operator-source-snapshot.js";
import type { CronStoredJob } from "../types.js";

/** Prepare current creator facts for placement; the occurrence admits the requester. */
export async function prepareCronCreatorSandbox(
  cfg: OpenClawConfig,
  job: CronStoredJob,
  signal?: AbortSignal,
): Promise<"required" | undefined> {
  signal?.throwIfAborted();
  const snapshot = readCronOperatorSnapshotForRun(job);
  const principal = snapshot?.openclawIdPrincipal;
  try {
    if (snapshot && principal?.kind === "member") {
      await prepareOpenClawIdTunnelPrincipal(principal);
      signal?.throwIfAborted();
      await prepareUserProfileRoleAuthority(snapshot.profileId);
      signal?.throwIfAborted();
    }
    return resolveCreatorSandbox(cfg, {
      actor: cronExecutionActor(job),
      openclawIdPrincipal: principal,
    });
  } catch (error) {
    if (!signal?.aborted && error instanceof GatewayOperatorRecoveryAuthorizationError) {
      throw new CronOperatorSourceError(error);
    }
    throw error;
  }
}
