import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import type { AdmittedRunInvocationAuthority } from "../agents/admitted-run-operator-authority.types.js";
import { intersectOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { intersectParticipationCeilings } from "../agents/participation-ceiling.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { ExecPolicyCeiling } from "../infra/exec-policy.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";

/** Retain a recovered source and its new exact invocation restriction as one producer. */
export function retainGatewayOperatorInvocation(
  captured: { authority: AdmittedRunOperatorAuthority; release: () => void },
  invocation: AdmittedRunInvocationAuthority | undefined,
) {
  if (!invocation) {
    return captured;
  }
  let references = 1;
  const releaseHold = () => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (--references === 0) {
        try {
          captured.release();
        } finally {
          invocation.release?.();
        }
      }
    };
  };
  const assertCurrent = composeSessionSourceAssertion(
    [() => captured.authority.signal?.throwIfAborted(), invocation.assertCurrent],
    (assertSources) => {
      if (!references) {
        throw new Error("Operator invocation was released");
      }
      invocation.signal?.throwIfAborted();
      assertSources();
    },
    { synchronousCheck: true },
  );
  assertCurrent();
  const signals = [captured.authority.signal, invocation.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const source = invocation.participationAuthority ?? captured.authority;
  const scopes = invocation.participationAuthority
    ? intersectOperatorScopes(captured.authority.scopes, source.scopes)
    : source.scopes;
  const participationCeiling = intersectParticipationCeilings(
    intersectParticipationCeilings(
      captured.authority.participationCeiling,
      source.participationCeiling,
    ),
    invocation.participationCeiling,
  );
  const authority = createAdmittedRunOperatorAuthority({
    ...source,
    invocation,
    scopes,
    participationCeiling,
    signal: AbortSignal.any(signals),
    get modelPolicy() {
      return invocation.participationAuthority
        ? intersectOperatorModelPolicy(
            captured.authority.modelPolicy,
            invocation.participationAuthority.modelPolicy,
          )
        : captured.authority.modelPolicy;
    },
    retain: () => {
      assertCurrent();
      references++;
      return releaseHold();
    },
  });
  return { authority, release: releaseHold() };
}

/** Child execution restrictions produce one live authority and matching durable source. */
export function deriveGatewayOperatorAuthorityForDelegation(
  authority: AdmittedRunOperatorAuthority,
  restrictions: { permission?: SessionPermissionMode; execPolicy?: ExecPolicyCeiling },
): AdmittedRunOperatorAuthority {
  authority.signal?.throwIfAborted();
  const ceiling = authority.participationCeiling;
  if (!ceiling) {
    return authority;
  }
  const participationCeiling = intersectParticipationCeilings(ceiling, {
    ...ceiling,
    permission: restrictions.permission ?? ceiling.permission,
    execPolicy: restrictions.execPolicy ?? ceiling.execPolicy,
  });
  const derived = createAdmittedRunOperatorAuthority({ ...authority, participationCeiling });
  if (!derived.recoverySnapshot) {
    throw new Error("Delegated participation requires a bounded retained source.");
  }
  return derived;
}
