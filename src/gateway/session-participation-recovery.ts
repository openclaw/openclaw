import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  intersectParticipationCeilings,
  type BoundParticipationCeiling,
} from "../agents/participation-ceiling.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** The recovery owner supplies already-authenticated custody, avoiding a recorded-source restore cycle. */
export async function prepareRecoveredParticipation(params: {
  context: GatewayRequestContext;
  authority: AdmittedRunOperatorAuthority;
  ceiling: BoundParticipationCeiling;
  revoke: (cause?: unknown) => void;
}) {
  const { authority, ceiling: retained, revoke } = params;
  const { prepareSessionPrincipalRunAuthority } =
    await import("./session-sharing-authorization-async.js");
  if (authority.profileId !== retained.profileId) {
    throw new GatewayOperatorRecoveryAuthorizationError("Interrupted requester identity changed.");
  }
  const access = await prepareSessionPrincipalRunAuthority({
    context: params.context,
    profileId: retained.profileId,
    agentId: retained.source.agentId,
    sessionKey: retained.sessionKey,
    sessionId: retained.source.sessionId,
    participationCeiling: retained,
    restored: {
      authority,
      release: authority.retain?.() ?? (() => {}),
    },
    assertCurrent: () => authority.signal?.throwIfAborted(),
  });
  const signal = access.authority.signal;
  const onRevoked = () => revoke(signal?.reason);
  const release = () => {
    signal?.removeEventListener("abort", onRevoked);
    access.release();
  };
  try {
    if (!access.participationCeiling) {
      throw new GatewayOperatorRecoveryAuthorizationError(
        "The original invitation no longer permits participation.",
      );
    }
    const ceiling = intersectParticipationCeilings(retained, access.participationCeiling);
    signal?.addEventListener("abort", onRevoked, { once: true });
    access.assertCurrent();
    return { ceiling, assertCurrent: access.assertCurrent, release };
  } catch (error) {
    release();
    throw error;
  }
}
