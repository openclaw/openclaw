import { randomUUID } from "node:crypto";
import type { GoalRecoveryDecision } from "../../../packages/gateway-protocol/src/schema/sessions-goal.js";
import type { SessionUnknownOutcomeDecision } from "../../../packages/gateway-protocol/src/schema/sessions-unknown-outcome.js";
import type { GatewayAuthPolicy } from "../../gateway/auth-policy.types.js";
import type { GatewayAccessGrantRef } from "../../plugins/gateway-access-policy.types.js";
import { hasRestartRecoveryTerminalRun } from "./restart-recovery-state.js";
import type { InternalSessionEntry } from "./types.js";

/** Verified host ingress references and original ceilings; never a serialized capability. */
export type GoalRecoveryIssuerBasis = {
  version: 1;
  profileId: string;
  /** Immutable subject verified at original Factory admission, never a credential. */
  factoryActor: Readonly<{ host: "microsoft.ghe.com"; accountId: number }>;
  assignedRole: string | null;
  rolePolicyGeneration: string | null;
  aliasBindingIds: readonly string[];
  scopes: readonly string[];
  modelCeilings: readonly string[];
  device: { deviceId: string; identity: string };
  authPrincipal: Pick<
    GatewayAuthPolicy,
    "role" | "verifiedIdentity" | "authMethod" | "authModeOverride" | "browserOrigin"
  >;
  authPolicyGeneration: string;
  sharedAuthGeneration: string | null;
  grant: GatewayAccessGrantRef | null;
};

export type GoalRecoveryIntent = {
  goalId: string;
  sessionId: string;
  sessionKey: string;
  lifecycleRevision?: string;
  issuer: GoalRecoveryIssuerBasis;
};

/** One durably accepted original user turn; input identity is custody, not authority. */
export type TurnRecoveryIntent = Omit<GoalRecoveryIntent, "goalId"> & {
  runId: string;
  inputId: string;
  idempotencyKey: string;
  /** Original capture epoch; re-admission advances the pending row's operational epoch separately. */
  lifecycleGeneration: string;
  repositoryWorkspaceId?: string;
};

export type NoReplayRecoveryDecision = SessionUnknownOutcomeDecision &
  Pick<GoalRecoveryIssuerBasis, "profileId" | "factoryActor">;

/** Public review facts carry no issuer or execution authority. */
export function projectNoGoalInterruptedAction(entry: InternalSessionEntry) {
  const state = entry.mainRestartRecovery;
  const pause = state?.pause;
  if (!pause || entry.goal || entry.restartRecoveryGoal || state.tombstone) {
    return undefined;
  }
  const turn = state.turnIntent;
  return {
    reason: pause.reason,
    toolCallId: pause.toolCallId,
    toolName: pause.toolName,
    ...(turn && pause.toolCallId
      ? {
          decision: {
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            cycleId: state.cycleId,
            revision: state.revision,
            pausedAtMs: pause.pausedAtMs,
            toolCallId: pause.toolCallId,
            runId: turn.runId,
          } satisfies SessionUnknownOutcomeDecision,
        }
      : {}),
  };
}

/** Private metadata of one accepted input; acceptance sequence remains owned by its row. */
export type PendingInputRecoveryIntent = {
  version: 1;
  intent: TurnRecoveryIntent;
  queued: boolean;
  requestHash: string;
  messageHash: string;
};

export function isInitialQueuedMainSessionInput(entry: InternalSessionEntry): boolean {
  const state = entry.mainRestartRecovery;
  return Boolean(
    state?.queuedInputId &&
    state.queuedInputId === state.turnIntent?.inputId &&
    state.startedAttempt === undefined,
  );
}

export type TurnRecoveryIssuerAdmission = {
  assertCurrent: () => void;
  capture: (
    entry: { sessionId: string; lifecycleRevision?: string; repositoryWorkspaceId?: string },
    input: { inputId: string; idempotencyKey: string },
  ) => TurnRecoveryIntent | undefined;
};

/** Current authenticated explicit-user admission paired with its reviewed hold. */
export type GoalRecoveryDecisionAdmission = {
  reference: GoalRecoveryDecision;
  sessionId: string;
  goalId: string;
  assertCurrent: () => void;
};

export function isGoalRecoveryDecisionCurrent(
  entry: Pick<InternalSessionEntry, "sessionId" | "goal" | "mainRestartRecovery">,
  admission: GoalRecoveryDecisionAdmission,
): boolean {
  admission.assertCurrent();
  const state = entry.mainRestartRecovery;
  return (
    entry.sessionId === admission.sessionId &&
    entry.goal?.id === admission.goalId &&
    state?.cycleId === admission.reference.cycleId &&
    state.revision === admission.reference.revision &&
    state.pause?.pausedAtMs === admission.reference.pausedAtMs
  );
}

/** Preparing acceptance remains owned until its exact turn settles, not until a model starts. */
export function isCapturedMainRestartTurnCurrent(entry: InternalSessionEntry): boolean {
  const turn = entry.mainRestartRecovery?.turnIntent;
  return Boolean(
    turn &&
    turn.sessionId === entry.sessionId &&
    turn.lifecycleRevision === entry.lifecycleRevision &&
    entry.archivedAt === undefined &&
    !hasRestartRecoveryTerminalRun(entry, turn.runId) &&
    !(entry.lastRunId === turn.runId && entry.status !== undefined),
  );
}

/** Host closure carried to the same fresh-row commit as the goal; never wire input. */
export type GoalRecoveryIssuerAdmission = {
  assertCurrent: () => void;
  capture: (
    entry: { sessionId: string; lifecycleRevision?: string },
    goal: { id: string },
  ) => GoalRecoveryIntent | undefined;
};

export type MainRestartRecoveryState = {
  /** Private original goal admission, retained independently of one interrupted episode. */
  goalIntent?: GoalRecoveryIntent;
  /** Current accepted turn, retained through interruption and cleared by terminal settlement. */
  turnIntent?: TurnRecoveryIntent;
  /** Exact unstarted accepted head; its original user message may already be committed. */
  queuedInputId?: string;
  /** Presence only; the pending-input table owns identities, order, and disposition. */
  queuedInputsPending?: true;
  /** Stable identity for one interrupted episode; prevents clear-and-rewedge ABA matches. */
  cycleId: string;
  /** Monotonic identity for observations within the current recovery cycle. */
  revision: number;
  /** Attempts charged when their reservation is persisted, before dispatch. */
  chargedAttempts: number;
  /** Last attempt observed starting a backend turn; later startup failures get a fresh budget. */
  startedAttempt?: number;
  /** A positively known capacity hold; worker facts attest a pre-execution wait. */
  capacityWait?: {
    runId: string;
    lifecycleGeneration: string;
    sinceMs: number;
    worker?: {
      environmentId: string;
      ownerEpoch: number;
      placementGeneration: number;
      claimId: string;
      nodeDeviceId: string;
      connId: string;
      pairingGeneration: string;
      launchId: string;
      planHash: string;
      attempt: number;
    };
    /** Exact settled provider rejection; never a projection of generic failure text. */
    provider?: {
      kind: "settled-shortage-v1";
      environmentId: string;
      ownerEpoch: number;
      placementGeneration: number;
      providerId: string;
      profileId: string;
      operationId: string;
      leaseId: string;
      attemptName: string;
      attemptNonce: string;
      providerCode: string;
      attempt: number;
      /** Restart's atomic refund also fences cleanup by the retired wait owner. */
      refunded?: true;
    };
  };
  /** Private safe token for one recovered outer turn; raw identity refs never enter session state. */
  executionIdentity?: {
    tokenVersion: 1;
    contextId: string;
    executionId: string;
    runId: string;
    createdAt: number;
  };
  reservation?: {
    runId: string;
    attempt: number;
    lifecycleGeneration: string;
  };
  foregroundClaims?: {
    lifecycleGeneration: string;
    tokens: string[];
    /** Run identity for claims that have crossed the actual agent-run boundary. */
    runIdsByClaimId?: Record<string, string>;
  };
  /** An unresolved effect holds the whole session until an explicit recovery decision. */
  pause?: {
    reason: "unverifiable-external-effect";
    toolCallId?: string;
    toolName?: string;
    pausedAtMs: number;
    goalId?: string;
  };
  /** Consumed only by this recovery cycle after an authenticated human continuation. */
  acknowledgedPause?: MainRestartRecoveryState["pause"];
  /** Same-cycle retry receipt only. The historical effect remains unknown, never replayable. */
  noReplayAcknowledgment?: { decision: NoReplayRecoveryDecision; acknowledgedAtMs: number };
  tombstone?: {
    reason: string;
    /** Durable successor returned when an explicit rollover request is retried. */
    recoveredSessionId?: string;
    recoveredSessionKey?: string;
  };
};

export function createMainRestartRecoveryCycle(
  cycleId: string = randomUUID(),
): MainRestartRecoveryState {
  return { cycleId, revision: 1, chargedAttempts: 0 };
}

/** A saved goal issuer owns intent only; interruption and its actual leases own recovery custody. */
export function hasMainRestartRecoveryEpisode(
  entry?: {
    mainRestartRecovery?: MainRestartRecoveryState;
    abortedLastRun?: boolean;
    restartRecoveryRuns?: readonly { runId: string }[];
  } | null,
): boolean {
  const state = entry?.mainRestartRecovery;
  return Boolean(
    state &&
    ((!state.goalIntent && !state.turnIntent && !state.queuedInputsPending) ||
      entry?.abortedLastRun === true ||
      entry?.restartRecoveryRuns?.length ||
      state.chargedAttempts !== 0 ||
      state.startedAttempt !== undefined ||
      state.reservation ||
      state.foregroundClaims ||
      state.capacityWait ||
      state.executionIdentity ||
      state.pause ||
      state.acknowledgedPause ||
      state.tombstone),
  );
}
