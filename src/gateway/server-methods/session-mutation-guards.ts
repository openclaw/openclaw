import {
  bindWorkerSourceAuthorization,
  composeWorkerPlacementAuthorization,
} from "../worker-environments/service-contract.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  SessionMutationAuthorization,
} from "./types.js";

// Runtime provenance is host-bound by ingress, never a request/model field.
// Human session mutation assertions remain ordinary lifecycle authorization.
export function sessionWorkerAuthorization(
  client: GatewayClient | null,
  context: GatewayRequestContext,
  authorization: SessionMutationAuthorization | undefined,
) {
  const identity = client?.internal?.agentRuntimeIdentity;
  if (!identity) {
    return authorization?.assertCurrent;
  }
  const validate = context.validateAgentRuntimeApprovalAuthority;
  return bindWorkerSourceAuthorization(() => {
    if (!validate || !validate(identity)) {
      throw new TypeError("agent runtime authority is no longer active");
    }
    authorization?.assertCurrent();
  });
}

/** Keep the host lifetime and operator target policy on the same commit boundary. */
export function withSessionMutationCommitGuard(
  authorization: SessionMutationAuthorization | undefined,
  assertCommitAllowed: (() => void) | undefined,
  assertExpectedProfile: (() => void) | undefined,
): SessionMutationAuthorization | undefined {
  if (!assertCommitAllowed && !assertExpectedProfile) {
    return authorization;
  }
  // Committed input keeps its original host and session authority. A later
  // account selection change cannot revoke custody already transferred to it.
  const assertAdmittedInputCurrent = composeWorkerPlacementAuthorization(
    assertCommitAllowed,
    authorization?.assertCurrent,
  );
  return {
    ...authorization,
    assertAdmittedInputCurrent,
    assertCurrent: composeWorkerPlacementAuthorization(
      assertExpectedProfile,
      assertAdmittedInputCurrent,
    ),
    assertTargetCurrent: (target) => {
      assertExpectedProfile?.();
      assertCommitAllowed?.();
      authorization?.assertTargetCurrent(target);
    },
  };
}
