import { readOperatorToolGatewayAuthority } from "../../gateway/operator-tool-gateway-authority.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { classifyToolAgainstSandboxToolPolicy } from "../sandbox/tool-policy.js";
import { SANDBOX_DEFAULT_TOOL_ALLOW, type SandboxToolPolicy } from "../sandbox/types.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";

export function captureSessionControlAuthority(prepared?: AdmittedRunOperatorAuthority) {
  const invocation = readOperatorToolGatewayAuthority();
  const caller = getGatewayToolCallerIdentity()?.operatorAuthority;
  const scope = getPluginRuntimeGatewayRequestScope();
  const retained = scope?.client?.internal?.operatorRunAuthority;
  const authority = prepared ?? caller ?? invocation?.operatorRunAuthority ?? retained;
  if (!authority) {
    return undefined;
  }
  const sources = [
    ...new Set([authority, caller, invocation?.operatorRunAuthority, retained]),
  ].filter((source): source is AdmittedRunOperatorAuthority => source !== undefined);
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const assertCurrent = () => {
    for (const source of sources) {
      assertAdmittedRunOperatorAuthority(source);
      source.assertCurrent();
      if (source.source !== authority.source) {
        throw new Error("Session control operator source changed.");
      }
    }
    assertCallerCurrent?.("sessions.patch");
    invocation?.signal.throwIfAborted();
    invocation?.assertCurrent?.();
    if (retained && scope?.hasCurrentClientAuthority?.() === false) {
      throw new Error("Session control caller authority is no longer active.");
    }
  };
  assertCurrent();
  return {
    authority,
    assertCurrent,
    allows: (requested: string) =>
      sources.every((source) => operatorScopeSatisfied(requested, source.scopes)) &&
      (!invocation || operatorScopeSatisfied(requested, invocation.scopes)) &&
      (!retained || operatorScopeSatisfied(requested, scope?.client?.connect.scopes ?? [])),
  };
}

/** Resolve the original host-issued source without upgrading an insufficient scope. */
export function readSessionControlAuthority(
  prepared?: AdmittedRunOperatorAuthority,
): AdmittedRunOperatorAuthority | undefined {
  return captureSessionControlAuthority(prepared)?.authority;
}

/** Availability only; the target guard and underlying Gateway policy still apply. */
export function hasSessionControlAuthority(prepared?: AdmittedRunOperatorAuthority): boolean {
  return captureSessionControlAuthority(prepared)?.allows("operator.write") ?? false;
}

/** Create and rename use the existing creator-scoped session write grant, not general controls. */
export function hasSessionWriteAuthority(prepared?: AdmittedRunOperatorAuthority): boolean {
  return captureSessionControlAuthority(prepared)?.allows("operator.sessions.write") ?? false;
}

/** Default guest exposure adds independent creation and label-only management, never full controls. */
export function prepareSandboxSessionTools(params: {
  policy?: SandboxToolPolicy;
  senderIsOwner?: boolean;
  authority?: AdmittedRunOperatorAuthority;
}): { policy?: SandboxToolPolicy; renameOnly: boolean } {
  const policy = params.policy;
  const defaultAllow = policy?.[SANDBOX_DEFAULT_TOOL_ALLOW];
  if (
    params.senderIsOwner !== false ||
    !policy ||
    !defaultAllow ||
    defaultAllow !== policy.allow ||
    !hasSessionWriteAuthority(params.authority)
  ) {
    return { policy, renameOnly: false };
  }
  const added = ["sessions", "sessions_create"].filter((name) => {
    const blocked = classifyToolAgainstSandboxToolPolicy(name, policy);
    return blocked.blockedByAllow && !blocked.blockedByDeny;
  });
  return {
    policy: added.length ? { ...policy, allow: [...defaultAllow, ...added] } : policy,
    renameOnly: added.includes("sessions"),
  };
}
