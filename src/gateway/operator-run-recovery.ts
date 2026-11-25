import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import {
  intersectOperatorScopes,
  operatorScopeSatisfied,
} from "../shared/operator-scope-compat.js";
import {
  decideChannelOwnerPrincipal,
  decideOperatorAdmission,
  decideTurnGrant,
  prepareOperatorAdmission,
  type OperatorAdmissionContext,
} from "./operator-admission.js";
import {
  captureChannelOperatorRunAuthority,
  prepareGatewayOperatorRunAuthority,
  type GatewayOperatorRunAdmissionInput,
  type PreparedGatewayOperatorRunAuthority,
} from "./operator-run-authority.js";
import { retainGatewayOperatorInvocation } from "./operator-run-invocation.js";
import {
  decodeQueuedOperatorRecoverySource,
  type OperatorRunRecoverySnapshot,
} from "./operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import type { GatewayAuthenticatedUserProfile } from "./server/client-identity-types.js";
import { prepareRecoveredParticipation } from "./session-participation-recovery.js";

export type RestoredGatewayOperatorAuthority = {
  authority: AdmittedRunOperatorAuthority;
  /** Only Gateway recovery reauthenticates a Control UI profile. */
  authenticatedUserProfile?: GatewayAuthenticatedUserProfile;
  controlUiAdmin: boolean;
  automationAdmin: boolean;
  release: () => void;
};

type QueuedRecoveryParams = {
  source: unknown;
  liveAuthority?: AdmittedRunOperatorAuthority;
  agentId?: string;
  context: OperatorAdmissionContext;
  assertCurrent: () => void;
};

/** Restore owner-held saved facts at the next start, never during the admitted run. */
export async function restoreGatewayOperatorSource(params: {
  snapshot: OperatorRunRecoverySnapshot;
  agentId?: string;
  context: OperatorAdmissionContext;
  assertCurrent: () => void;
}): Promise<RestoredGatewayOperatorAuthority> {
  return restoreGatewayQueuedOperatorRecovery({
    source: { kind: "gateway", snapshot: params.snapshot },
    agentId: params.agentId,
    context: params.context,
    assertCurrent: params.assertCurrent,
  });
}

/**
 * A queued native launch reuses its original authenticated source, never profile attribution.
 * Chat-like starts need the grant a live chat.send needs: operator.sessions.write.
 */
export async function restoreGatewayQueuedOperatorRecovery(params: QueuedRecoveryParams) {
  return admitStart(params, "operator.sessions.write", "sending messages");
}

/** A queued Talk consult starts on the grant that created it: operator.talk, or write. */
export async function restoreTalkConsultOperator(params: QueuedRecoveryParams) {
  return admitStart(params, "operator.talk", "using Talk");
}

/** Scheduled automations start on the grant that creates them: operator.cron, or write. */
export async function restoreScheduledAutomationOperator(params: QueuedRecoveryParams) {
  return admitStart(params, "operator.cron", "running this automation");
}

/** Admission only narrows scopes; a start also needs its grant. Channel senders need none. */
async function admitStart(
  params: QueuedRecoveryParams,
  grant: "operator.sessions.write" | "operator.talk" | "operator.cron",
  action: string,
): Promise<RestoredGatewayOperatorAuthority> {
  const admitted = await admitQueuedSource(params);
  const { channelRecoverySource, scopes } = admitted.authority;
  if (
    !channelRecoverySource &&
    !operatorScopeSatisfied(
      admitted.authority.participationCeiling && grant === "operator.sessions.write"
        ? "operator.sessions.read"
        : grant,
      scopes,
    )
  ) {
    admitted.release();
    throw new GatewayOperatorRecoveryAuthorizationError(
      `Your operator role no longer allows ${action}; ask an administrator to restore access.`,
    );
  }
  return admitted;
}

async function admitQueuedSource(
  params: QueuedRecoveryParams,
): Promise<RestoredGatewayOperatorAuthority> {
  params.assertCurrent();
  const captured = decodeQueuedOperatorRecoverySource(params.source);
  // Same-process work keeps its live facts; a saved channel owner is admitted again from config.
  let live =
    captured.kind === "unavailable" || captured.kind === "channel-owner"
      ? params.liveAuthority
      : undefined;
  if (!live && captured.kind === "channel-owner") {
    const getConfig = params.context.getCommittedRuntimeConfig ?? params.context.getRuntimeConfig;
    const principal = decideChannelOwnerPrincipal(getConfig(), captured.sender);
    if (!principal) {
      throw new GatewayOperatorRecoveryAuthorizationError(
        "This sender is no longer in commands.ownerAllowFrom, so its saved work cannot run. Send a new message.",
      );
    }
    live = captureChannelOperatorRunAuthority({ ...principal, getRuntimeConfig: getConfig });
  }
  const capturedFacts = live ? ({ kind: "live", authority: live } as const) : captured;
  if (capturedFacts.kind === "unavailable" || capturedFacts.kind === "channel-owner") {
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
  const admitted = decideOperatorAdmission(facts, prepared);
  const ceiling =
    facts.kind === "gateway"
      ? facts.snapshot.participationCeiling
      : facts.kind === "live"
        ? facts.authority.participationCeiling
        : undefined;
  if (!ceiling) {
    return admitted;
  }
  try {
    const context = params.context.resolveGatewayContext?.();
    if (!context) {
      throw new GatewayOperatorRecoveryAuthorizationError(
        "Participant continuation requires its original Gateway.",
      );
    }
    const revoked = new AbortController();
    const participation = await prepareRecoveredParticipation({
      context,
      authority: admitted.authority,
      ceiling,
      revoke: (cause) => revoked.abort(cause),
    });
    return {
      ...admitted,
      ...retainGatewayOperatorInvocation(admitted, {
        participationCeiling: participation.ceiling,
        assertCurrent: () => {
          revoked.signal.throwIfAborted();
          participation.assertCurrent();
        },
        signal: revoked.signal,
        release: participation.release,
      }),
    };
  } catch (error) {
    admitted.release();
    throw error;
  }
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
  // In-run continuations re-admit without a start grant: a started run finishes.
  const restored = await admitQueuedSource({
    source: facts,
    liveAuthority: inherited,
    agentId: input.agentId,
    context,
    assertCurrent: () => {},
  });
  const scopes = intersectOperatorScopes(
    restored.authority.scopes,
    input.client?.connect.scopes ?? [],
  );
  const authority = createAdmittedRunOperatorAuthority({
    ...restored.authority,
    // One origin keeps one comparable source identity, as completion batches require.
    source: inherited.source,
    scopes,
    grant: decideTurnGrant(scopes),
  });
  return retainGatewayOperatorInvocation(
    { authority, release: restored.release },
    input.invocationAuthority,
  );
}
