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
import type { FollowupCompletionOwner } from "../../agents/subagents/completion/session-followup-completion.types.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import type { registerChatAbortController } from "../chat-abort.js";
import type { ChatImageContent, OffloadedRef } from "../chat-attachments.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import type { GatewayCronCreatorAuthorityAdmission } from "../server-methods/cron-creator-authority-admission.js";
import type { AgentDeliveryPhaseResult } from "./agent-delivery-phase.js";
import type { RestoredCronContinuation } from "./agent-handler-helpers.js";
import type { PreparedAgentRunUserTurn } from "./agent-run-user-turn.js";
import type { RequesterSettleWakeReplay } from "./internal-facade.types.js";
import type { AgentTurnContext, AgentTurnIo, AgentTurnPrincipal } from "./types.js";

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
  reactivateSubagent: boolean;
  followupCompletion?: FollowupCompletionOwner;
  preparedModelRuntimeLease: PreparedModelRuntimeLease;
  replyDispatchRuntime: PreparedReplyDispatchRuntime;
  unpersistedOffloadedRefs: OffloadedRef[];
  userTurn: PreparedAgentRunUserTurn;
  workspaceOverride?: string;
  restoreAdmittedRestartRecoveryInterrupted?: () => Promise<
    MainSessionRecoveryPendingTarget | undefined
  >;
};

export type PrepareAgentRunDispatchParams = {
  assertAdmissionCurrent?: () => void;
  hasCurrentClientAuthority?: () => boolean;
  promptedAt: number;
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  cfgForAgent?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  resolvedSessionKey?: string;
  requestedSessionKeyRaw?: string;
  requestedSessionKey?: string;
  preAcceptedReservedSessionKey?: string;
  activeSessionAgentId: string;
  delivery: AgentDeliveryPhaseResult;
  restoredCronContinuationIdentity?: Pick<
    RestoredCronContinuation,
    "lifecycleRevision" | "sessionId"
  >;
  restoredCronContinuation?: RestoredCronContinuation;
  providerOverride?: string;
  modelOverride?: string;
  allowModelOverride: boolean;
  lifecycleGeneration: string;
  getAdmittedSessionId: () => string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  suppressVisibleSessionEffects: boolean;
  pendingChatRun?: { sessionKey: string; agentId?: string };
  inputProvenance?: InputProvenance;
  isOneShotModelRun: boolean;
  isRestartRecoveryResumeRun: boolean;
  canUseInternalRuntimeHandoff: boolean;
  execApprovalFollowupApprovalId?: string;
  message: string;
  effectiveTranscriptInputText: string;
  images: ChatImageContent[];
  offloadedRefs: OffloadedRef[];
  onUserTurnMediaPersisted: () => void;
  requestedPromptPersistenceSuppression: boolean;
  privateCompletion?: true;
  settleWakeReplay?: RequesterSettleWakeReplay;
  runId: string;
  agentDedupeKeys: readonly string[];
  getOwnedAgentDedupeKeys: () => readonly string[];
  context: AgentTurnContext;
  client: AgentTurnPrincipal | null;
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
