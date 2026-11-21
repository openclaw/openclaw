import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareOpenClawIdTunnelPrincipal } from "../../gateway/openclaw-id/tunnel-principal.js";
import { operatorRoleSubject } from "../../gateway/operator-role-enforcement.js";
import {
  resolveCreatorSandbox,
  resolveOperatorRolePolicyForAssignment,
} from "../../gateway/operator-role-policy.js";
import {
  isOperatorRoleSourcePolicyCurrent,
  sourceRolePolicy,
} from "../../gateway/operator-role-source-policy.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../../infra/restart-recovery-errors.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import { cronExecutionActor } from "../human-owner.js";
import { CronOperatorSourceError } from "../operator-source-error.js";
import { readCronOperatorSnapshotForRun } from "../operator-source-snapshot.js";
import type { CronStoredJob } from "../types.js";

/** Check stored member policy before session creation, without retiring transient failures. */
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
      const profile = await prepareUserProfileRoleAuthority(snapshot.profileId);
      signal?.throwIfAborted();
      if (
        !isOperatorRoleSourcePolicyCurrent(
          snapshot.rolePolicy,
          sourceRolePolicy(
            resolveOperatorRolePolicyForAssignment(
              profile?.profileId,
              profile?.role ?? null,
              cfg,
              profile?.githubLogin ?? null,
              operatorRoleSubject(profile),
            ),
          ),
          snapshot.scopes,
        )
      ) {
        throw new GatewayOperatorRecoveryAuthorizationError(
          "Restart recovery operator source policy changed.",
        );
      }
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
