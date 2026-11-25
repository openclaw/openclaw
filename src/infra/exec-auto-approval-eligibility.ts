import type { ExecAuthorizationPlan } from "./exec-authorization-plan.js";
import { EXEC_AUTO_REVIEW_DISPATCH_IDENTITY_WARNING } from "./exec-auto-review.js";
import { resolveExecWrapperTrustPlan } from "./exec-wrapper-trust-plan.js";
import type { SystemRunMutableFileBinding } from "./system-run-approval-binding.js";

/** Original-text review requires proof of every dispatch, not just its policy projection. */
export function resolveUnpinnedAutoApprovalEligibility(params: {
  authorizationPlan: ExecAuthorizationPlan | undefined;
  binding: SystemRunMutableFileBinding | undefined;
  platform?: NodeJS.Platform;
}): { eligible: true } | { eligible: false; reason: string } {
  const ineligible = {
    eligible: false,
    reason: EXEC_AUTO_REVIEW_DISPATCH_IDENTITY_WARNING,
  } as const;
  if (!params.authorizationPlan?.ok || !params.binding) {
    return ineligible;
  }
  const candidates = params.authorizationPlan.groups.flatMap((group) => group.candidates);
  if (candidates.length === 0) {
    return ineligible;
  }
  for (const candidate of candidates) {
    // A projected payload omits the transport shell and its dispatch semantics.
    if (candidate.transport.kind !== "direct") {
      return ineligible;
    }
    const segment = candidate.sourceSegment;
    const trustPlan = resolveExecWrapperTrustPlan(
      segment.sourceArgv ?? segment.argv,
      undefined,
      params.platform,
    );
    if (segment.resolution?.policyBlocked || !trustPlan.dispatchChain) {
      return ineligible;
    }
    const expectedOperands = [
      ...trustPlan.dispatchChain.slice(0, -1).map((argv) => argv.slice(0, 1)),
      segment.argv,
    ];
    if (
      !expectedOperands.every((argv) =>
        params.binding?.operands.some(
          (operand) =>
            operand.executable === true &&
            operand.snapshot.argvIndex === 0 &&
            operand.argv.length === argv.length &&
            operand.argv.every((token, index) => token === argv[index]),
        ),
      )
    ) {
      return ineligible;
    }
  }
  return { eligible: true };
}
