import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { readOperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.js";
import type { OperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.types.js";

function hasOperatorToolSource(authority: OperatorToolGatewayAuthority | undefined): boolean {
  return Boolean(
    authority?.operatorRunAuthority ||
    authority?.operatorRoleActor?.kind === "operator" ||
    (!authority?.operatorRoleActor && authority?.authenticatedUserProfile),
  );
}

/** Known operator sources cannot turn missing Gateway routing into standalone host access. */
export function hasOperatorToolGatewayAuthority(): boolean {
  const admitted = getGatewayToolCallerIdentity()?.operatorAuthority;
  admitted?.assertCurrent();
  const direct = readOperatorToolGatewayAuthority();
  direct?.signal.throwIfAborted();
  direct?.assertCurrent?.();
  direct?.operatorRunAuthority?.assertCurrent();
  const scope = getPluginRuntimeGatewayRequestScope();
  const scopedOperator = Boolean(
    scope?.client?.authenticatedUserProfile ||
    scope?.client?.internal?.operatorRoleActor?.kind === "operator",
  );
  if (scopedOperator) {
    scope?.signal?.throwIfAborted();
    if (scope?.hasCurrentClientAuthority?.() === false) {
      throw new Error("Gateway caller authority is no longer active.");
    }
  }
  return Boolean(admitted || hasOperatorToolSource(direct) || scopedOperator);
}

/** Retain the already-issued source and its invocation fence for SDK-owned selection writes. */
export function captureOperatorToolGatewayAuthority():
  | { authority: AdmittedRunOperatorAuthority | undefined; assertCurrent: () => void }
  | undefined {
  const admitted = getGatewayToolCallerIdentity()?.operatorAuthority;
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const direct = readOperatorToolGatewayAuthority();
  const ambientScope = getPluginRuntimeGatewayRequestScope();
  const scope = ambientScope ? { ...ambientScope } : undefined;
  const authority =
    admitted ?? direct?.operatorRunAuthority ?? scope?.client?.internal?.operatorRunAuthority;
  const requiresOperatorAuthority = Boolean(
    admitted ||
    hasOperatorToolSource(direct) ||
    resolveGatewayOperatorRoleActor(scope?.client)?.kind === "operator",
  );
  if (!authority && !assertCallerCurrent && !direct && !requiresOperatorAuthority) {
    return undefined;
  }
  return {
    authority,
    assertCurrent: () => {
      assertCallerCurrent?.();
      direct?.assertCurrent?.();
      if (!admitted && !assertCallerCurrent) {
        direct?.signal.throwIfAborted();
        scope?.signal?.throwIfAborted();
        if (scope?.hasCurrentClientAuthority?.() === false) {
          throw new Error("Gateway caller authority is no longer active.");
        }
      }
      if (requiresOperatorAuthority && !authority) {
        throw new Error("Operator model selection requires original Gateway authority.");
      }
    },
  };
}

/** Acquire the ambient requester; consumers own retention through their distinct work lifetimes. */
export async function captureAmbientGatewayOperatorAuthority(params: {
  missingBindingError: () => Error;
  retainInherited?: true;
}): Promise<{
  authority?: AdmittedRunOperatorAuthority;
  assertInvocationCurrent?: () => void;
  release?: () => void;
}> {
  const ambientScope = getPluginRuntimeGatewayRequestScope();
  const scope = ambientScope ? { ...ambientScope } : undefined;
  const invocation = captureOperatorToolGatewayAuthority();
  const inheritedOperator = invocation?.authority;
  const context = scope?.context ?? scope?.resolveGatewayContext?.();
  const assertInvocationCurrent =
    inheritedOperator || !scope?.client || !context
      ? invocation?.assertCurrent
      : captureGatewayToolCallerAssertion();
  if (inheritedOperator) {
    if (params.retainInherited) {
      assertAdmittedRunOperatorAuthority(inheritedOperator);
      inheritedOperator.assertCurrent();
    }
    return {
      authority: inheritedOperator,
      assertInvocationCurrent,
      release: params.retainInherited ? inheritedOperator.retain?.() : undefined,
    };
  }
  if (
    scope?.client &&
    !context &&
    resolveGatewayOperatorRoleActor(scope.client)?.kind === "operator"
  ) {
    throw params.missingBindingError();
  }
  const capturedOperator =
    scope?.client && context
      ? await captureGatewayOperatorRunAuthority({
          client: scope.client,
          context,
          hasCurrentClientAuthority: scope.hasCurrentClientAuthority,
          invocationAuthority: {
            assertCurrent: () => scope.signal?.throwIfAborted(),
            signal: scope.signal,
          },
        })
      : undefined;
  try {
    assertInvocationCurrent?.();
    scope?.signal?.throwIfAborted();
    if (
      scope?.hasCurrentClientAuthority?.() === false ||
      (scope?.resolveGatewayContext && scope.resolveGatewayContext() !== context)
    ) {
      throw new Error("Gateway caller authority is no longer active.");
    }
    capturedOperator?.authority.assertCurrent();
    return { ...capturedOperator, assertInvocationCurrent };
  } catch (error) {
    capturedOperator?.release();
    throw error;
  }
}
