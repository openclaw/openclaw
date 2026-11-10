import { z } from "zod";
import {
  GatewayControlUiIngressError,
  type GatewayIngressPrincipal,
} from "../plugins/gateway-ingress.types.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  onOpenClawIdTunnelPrincipalsChanged,
  openClawIdRecoveryPrincipalSchema,
  prepareOpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import type { GatewayClient } from "./server-methods/client-types.js";

const admissionSchema = z.strictObject({
  profileId: z.string().min(1).max(256),
  principal: openClawIdRecoveryPrincipalSchema,
});
const MAX_ADMISSION_LENGTH = 4096;

function denied(): GatewayControlUiIngressError {
  return new GatewayControlUiIngressError(
    "forbidden",
    "The approving sign-in authority is no longer available. Sign in and approve this app again.",
  );
}

function decodeAdmission(
  principal: Extract<GatewayIngressPrincipal, { kind: "delegated-person" }>,
) {
  try {
    if (
      typeof principal.admission !== "string" ||
      principal.admission.length > MAX_ADMISSION_LENGTH
    ) {
      throw denied();
    }
    const admission = admissionSchema.parse(JSON.parse(principal.admission));
    if (admission.profileId !== principal.profileId) {
      throw denied();
    }
    return admission.principal;
  } catch {
    throw denied();
  }
}

/** Capture the authenticated caller's source, never infer it from the profile's identities. */
export function captureGatewayIngressPersonPrincipal(
  client: GatewayClient,
): GatewayIngressPrincipal {
  const profileId = client.authenticatedUserProfile?.profileId;
  const actor = client.internal?.operatorRoleActor;
  if (
    !client.internal?.authenticatedOperator ||
    !profileId ||
    actor?.kind === "system" ||
    (actor?.kind === "operator" && actor.profileId !== profileId)
  ) {
    throw denied();
  }
  const remote = client.internal.remoteIngressPrincipal;
  remote?.assertCurrent();
  if (remote?.admission !== undefined) {
    return { kind: "delegated-person", profileId, admission: remote.admission };
  }
  const source = client.internal.openclawIdPrincipal;
  if (!source) {
    return { kind: "person", profileId };
  }
  const principal = openClawIdRecoveryPrincipalSchema.safeParse(source);
  if (!principal.success || !isOpenClawIdTunnelPrincipalCurrent(principal.data)) {
    throw denied();
  }
  return {
    kind: "delegated-person",
    profileId,
    admission: JSON.stringify({ profileId, principal: principal.data }),
  };
}

/** Membership owns admission; this lifetime only carries its decisions into delegated work. */
export async function prepareGatewayIngressPrincipalAdmission(
  principal: GatewayIngressPrincipal,
  lifetime: AbortSignal,
) {
  if (principal.kind !== "delegated-person") {
    return undefined;
  }
  const source = decodeAdmission(principal);
  const invalidated = new AbortController();
  const signal = AbortSignal.any([lifetime, invalidated.signal]);
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (!isOpenClawIdTunnelPrincipalCurrent(source)) {
      invalidated.abort(denied());
      throw denied();
    }
  };
  const unsubscribe = onOpenClawIdTunnelPrincipalsChanged(() => {
    try {
      assertCurrent();
    } catch (error) {
      invalidated.abort(error);
    }
  });
  const release = () => {
    unsubscribe();
    signal.removeEventListener("abort", release);
  };
  signal.addEventListener("abort", release, { once: true });
  try {
    signal.throwIfAborted();
    await prepareOpenClawIdTunnelPrincipal(source);
    assertCurrent();
    return { signal, assertCurrent, release };
  } catch {
    release();
    throw denied();
  }
}
