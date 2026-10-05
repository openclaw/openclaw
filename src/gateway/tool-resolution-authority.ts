import {
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";

/** Construction cancellation must not become the lifetime of a cached tool. */
export function captureGatewayToolResolutionAuthority(
  params: {
    admittedRunContext?: AdmittedRunContext;
    isGrantCurrent?: () => boolean;
    assertInvocationCurrent?: () => void;
  },
  assertPreparationCurrent?: () => void,
) {
  const assertRunCurrent = params.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(params.admittedRunContext)
    : undefined;
  const assertInvocationCurrent = () => {
    if (params.isGrantCurrent && !params.isGrantCurrent()) {
      throw new Error("Gateway tool invocation grant is no longer active");
    }
    params.assertInvocationCurrent?.();
    assertRunCurrent?.();
  };
  return {
    assertInvocationCurrent,
    assertCurrent: () => {
      assertPreparationCurrent?.();
      assertInvocationCurrent();
    },
  };
}
