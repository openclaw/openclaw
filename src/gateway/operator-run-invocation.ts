import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { intersectOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { intersectParticipationCeilings } from "../agents/participation-ceiling.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import { bindGatewayDeviceRevocation } from "./device-revocation.js";
import type { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";

/** Retain a recovered source and its new exact invocation restriction as one producer. */
export function retainGatewayOperatorInvocation(
  captured: { authority: AdmittedRunOperatorAuthority; release: () => void },
  invocation: Parameters<typeof captureGatewayOperatorRunAuthority>[0]["invocationAuthority"],
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
    [captured.authority.assertCurrent, invocation.assertCurrent],
    (assertSources) => {
      if (!references) {
        throw new Error("Operator invocation was released");
      }
      invocation.signal?.throwIfAborted();
      assertSources();
    },
    { synchronousCheck: true },
  );
  const signals = [captured.authority.signal, invocation.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const authority = createAdmittedRunOperatorAuthority({
    ...captured.authority,
    invocation,
    scopes: invocation.participationAuthority
      ? intersectOperatorScopes(captured.authority.scopes, invocation.participationAuthority.scopes)
      : captured.authority.scopes,
    participationCeiling: intersectParticipationCeilings(
      captured.authority.participationCeiling,
      invocation.participationAuthority?.participationCeiling,
    ),
    assertCurrent,
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
  bindGatewayDeviceRevocation(authority.assertCurrent, captured.authority.assertCurrent);
  return { authority, release: releaseHold() };
}
