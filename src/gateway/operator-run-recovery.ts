import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import {
  decideOperatorAdmission,
  prepareOperatorAdmission,
  type OperatorAdmissionContext,
} from "./operator-admission.js";
import {
  prepareGatewayOperatorRunAuthority,
  type GatewayOperatorRunAdmissionInput,
  type PreparedGatewayOperatorRunAuthority,
} from "./operator-run-authority.js";
import {
  decodeQueuedOperatorRecoverySource,
  type OperatorRunRecoverySnapshot,
  type RestartRecoveryOperatorSource,
} from "./operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import type { GatewayAuthenticatedUserProfile } from "./server/client-identity-types.js";

export type RestoredGatewayOperatorAuthority = {
  authority: AdmittedRunOperatorAuthority;
  authenticatedUserProfile: GatewayAuthenticatedUserProfile;
  controlUiAdmin: boolean;
  automationAdmin: boolean;
  release: () => void;
};

/** Restore owner-held saved facts at the next start, never during the admitted run. */
export async function restoreGatewayOperatorSource(params: {
  snapshot: OperatorRunRecoverySnapshot;
  source?: RestartRecoveryOperatorSource;
  agentId?: string;
  context: OperatorAdmissionContext;
  assertCurrent: () => void;
  prepareCurrent?: () => Promise<void>;
}): Promise<RestoredGatewayOperatorAuthority> {
  await params.prepareCurrent?.();
  const facts = {
    kind: "gateway",
    snapshot: params.snapshot,
    source: params.source,
    agentId: params.agentId,
  } as const;
  const prepared = await prepareOperatorAdmission(facts, params.context);
  try {
    // This producer's custody fence checks the claim/occurrence, not requester policy.
    params.assertCurrent();
  } catch (error) {
    prepared.ingress?.release();
    prepared.identity?.release();
    throw error;
  }
  return decideOperatorAdmission(facts, prepared);
}

/** A queued native launch reuses its original authenticated source, never profile attribution. */
export async function restoreGatewayQueuedOperatorRecovery(params: {
  source: unknown;
  liveAuthority?: AdmittedRunOperatorAuthority;
  operatorSource?: RestartRecoveryOperatorSource;
  agentId?: string;
  context: OperatorAdmissionContext;
  assertCurrent: () => void;
}): Promise<
  Pick<
    RestoredGatewayOperatorAuthority,
    "authority" | "controlUiAdmin" | "automationAdmin" | "release"
  > & {
    /** Only Gateway recovery reauthenticates a Control UI profile. */
    authenticatedUserProfile?: GatewayAuthenticatedUserProfile;
  }
> {
  params.assertCurrent();
  const captured = decodeQueuedOperatorRecoverySource(params.source);
  const capturedFacts =
    captured.kind === "unavailable" && params.liveAuthority
      ? ({ kind: "live", authority: params.liveAuthority } as const)
      : captured.kind === "gateway" && params.operatorSource
        ? { ...captured, source: params.operatorSource }
        : captured;
  if (capturedFacts.kind === "unavailable") {
    throw new Error("Queued operator authority cannot be recovered; submit a new request.");
  }
  const facts = { ...capturedFacts, agentId: params.agentId };
  const prepared = await prepareOperatorAdmission(facts, params.context);
  try {
    // This producer's custody fence checks the claim/occurrence, not requester policy.
    params.assertCurrent();
  } catch (error) {
    prepared.ingress?.release();
    prepared.identity?.release();
    throw error;
  }
  return decideOperatorAdmission(facts, prepared);
}

/** Accepted work runs on its origin's saved facts and current policy, not its accepting request. */
export async function captureGatewayOperatorContinuation(
  input: GatewayOperatorRunAdmissionInput,
): Promise<PreparedGatewayOperatorRunAuthority | undefined> {
  const inherited = input.client?.internal?.operatorRunAuthority;
  if (!inherited) {
    return prepareGatewayOperatorRunAuthority(input);
  }
  const facts = captureQueuedOperatorRecoverySource(inherited) ?? { kind: "unavailable" };
  const context = input.context.resolveGatewayContext?.() ?? input.context;
  const restored = await restoreGatewayQueuedOperatorRecovery({
    source: facts,
    liveAuthority: inherited,
    agentId: input.agentId,
    context,
    assertCurrent: () => {},
  });
  const authority = createAdmittedRunOperatorAuthority({
    ...restored.authority,
    // One origin keeps one comparable source identity, as completion batches require.
    source: inherited.source,
    scopes: intersectOperatorScopes(restored.authority.scopes, input.client?.connect.scopes ?? []),
  });
  return { authority, release: restored.release };
}
