import type {
  AdmittedRunOperatorAuthority,
  OperationalRunInstanceRef,
} from "../../agents/admitted-run-context.js";
import type { MainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import type {
  PreparedModelRuntimeLease,
  PreparedReplyDispatchRuntime,
} from "../../agents/prepared-model-runtime.js";
import type { TrustedSubagentCompletionHandoff } from "../../agents/subagents/announce/subagent-announce-handoff.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import type { registerChatAbortController } from "../chat-abort.js";
import type { OffloadedRef } from "../chat-attachments.js";
import type { GatewayCronCreatorAuthorityAdmission } from "../server-methods/cron-creator-authority-admission.js";
import type { AgentDeliveryPhaseResult } from "./agent-delivery-phase.js";
import type { RestoredCronContinuation } from "./agent-handler-helpers.js";
import type { GatewayAgentDispatchTaskTracking } from "./agent-run-task-tracking.js";
import type { PreparedAgentRunUserTurn, prepareAgentRunUserTurn } from "./agent-run-user-turn.js";
import type { AgentTurnIo } from "./types.js";

export type PreparedAgentRunDispatch = {
  activeGatewayWorkAdmission: SessionWorkAdmissionLease;
  activeRunAbort: ReturnType<typeof registerChatAbortController>;
  cronCreatorAuthority?: GatewayCronCreatorAuthorityAdmission;
  releaseCallerAuthority?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  operationalRunInstance: OperationalRunInstanceRef;
  effectiveProviderOverride?: string;
  effectiveModelOverride?: string;
  effectiveThinking?: string;
  effectiveAllowModelOverride: boolean;
  trustedInternalHandoff?: TrustedSubagentCompletionHandoff;
  restoredCronContinuationLifecycleRevision?: string;
  lifecycleStorePath: string;
  resolvedThreadId?: string | number;
  dispatchTaskTrackingMode: GatewayAgentDispatchTaskTracking;
  preparedModelRuntimeLease: PreparedModelRuntimeLease;
  replyDispatchRuntime: PreparedReplyDispatchRuntime;
  unpersistedOffloadedRefs: OffloadedRef[];
  userTurn: PreparedAgentRunUserTurn;
  workspaceOverride?: string;
  restoreAdmittedRestartRecoveryInterrupted?: () => Promise<
    MainSessionRecoveryPendingTarget | undefined
  >;
};

export type PrepareAgentRunDispatchParams = Omit<
  Parameters<typeof prepareAgentRunUserTurn>[0],
  | "assertCurrent"
  | "assertCompletionCurrent"
  | "abortSignal"
  | "getAbortStopReason"
  | "deferTimeoutCompletion"
  | "admittedSessionId"
  | "resolvedThreadId"
> & {
  assertAdmissionCurrent?: () => void;
  hasCurrentClientAuthority?: () => boolean;
  promptedAt: number;
  requestedSessionKey?: string;
  preAcceptedReservedSessionKey?: string;
  delivery: AgentDeliveryPhaseResult;
  restoredCronContinuationIdentity?: Pick<
    RestoredCronContinuation,
    "lifecycleRevision" | "sessionId"
  >;
  providerOverride?: string;
  modelOverride?: string;
  allowModelOverride: boolean;
  lifecycleGeneration: string;
  getAdmittedSessionId: () => string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  pendingChatRun?: { sessionKey: string; agentId?: string };
  isOneShotModelRun: boolean;
  isRestartRecoveryResumeRun: boolean;
  onUserTurnMediaPersisted: () => void;
  agentDedupeKeys: readonly string[];
  getOwnedAgentDedupeKeys: () => readonly string[];
  io: AgentTurnIo;
  abortForLifecycleRotation: (target?: { sessionKey?: string; agentId?: string }) => boolean;
  acquireGatewayWorkAdmission: (scope: string) => Promise<void>;
  assertGatewayWorkAdmissionAllowed: () => void;
  hasGatewayAdmissionOutcome: () => boolean;
  respondToGatewayAdmissionOutcome: () => boolean;
  admissionAgentId: () => string | undefined;
  getGatewayWorkAdmission: () => SessionWorkAdmissionLease | undefined;
  setAdmittedRunAbort: (value: ReturnType<typeof registerChatAbortController>) => void;
  getAdmittedRunAbort: () => ReturnType<typeof registerChatAbortController> | undefined;
  markAgentRunAccepted: (accepted: boolean) => void;
};
