/** Host-owned event admission and settlement contracts; no live reply/Gateway imports. */
import type {
  AdmittedRunContext,
  AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import type { MessagingToolSend } from "../../agents/embedded-agent-messaging.types.js";
import type {
  EmbeddedAgentRunMeta,
  EmbeddedAgentRunPayload,
} from "../../agents/embedded-agent-runner/result.types.js";
import type { ResolvedToolPromptFinalizer } from "../../agents/resolved-tool-prompt.types.js";
import type { SessionEntryCreationOperation } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  CronAgentExecutionPhaseUpdate,
  CronRunOutcome,
  CronRunTelemetry,
  CronStoredJob,
} from "../../cron/types.js";
import type { ExecRequestOwner } from "../../infra/exec-request-context.js";
import type {
  SourceDeliveryOutcome,
  SourceDeliveryPlan,
} from "../../infra/outbound/source-delivery-plan.types.js";
import type { SystemEvent } from "../../infra/system-events.js";
import type { ReplyOperationObservation } from "../../sessions/reply-operation-state.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";

type SessionEventSource =
  | "exec"
  | "node"
  | "task"
  | "hook"
  | "restart"
  | "session"
  | "device"
  | "plugin"
  | "cron";
export type SessionEventOutcome = {
  status: "completed" | "failed" | "cancelled";
  executionStarted: boolean;
  delivered: boolean;
  summary?: string;
  nextCheckMs?: number;
  sourceDeliveryOutcome?: SourceDeliveryOutcome;
  automationResult?: CronRunTelemetry & Pick<CronRunOutcome, "replyDisposition" | "diagnostics">;
  /** Recorded controller restart outcome, before the error is flattened. */
  interruptedByRestart?: boolean;
  error?: string;
  /** Admission policy decides whether a durable producer may retry this refusal. */
  retryable?: boolean;
  deliveryAttempted?: boolean;
  deliveryAmbiguous?: boolean;
  deliveryError?: string;
  deliverySuppressionReason?: NormalizeReplySkipReason;
  admissionDeferred?: boolean;
  admissionDeferredReason?: CronRunOutcome["admissionDeferredReason"];
};
export type SessionEventReceipt = {
  id: string;
  cancel: () => boolean;
  /** Resolves after ordinary turn adoption or committed follow-up queue admission. */
  accepted: Promise<{ ok: true } | { ok: false; error: string }>;
  settled: Promise<SessionEventOutcome>;
};

export type SessionEventTarget = {
  /** Host-captured producer authority, never a structural plugin input. */
  assertCurrent?: () => void;
  /** Captured internal-only completion policy for a retained producer. */
  deliver?: boolean;
  sessionId: string;
  storePath?: string;
  lifecycleRevision?: string;
  generation: string;
  deliveryContext?: DeliveryContext;
  chatType?: SessionEntry["chatType"];
  settings?: Readonly<Pick<SessionEntry, "permissionMode" | "toolOverrides">> | undefined;
  toolsAllow?: string[];
  agentId?: string;
  sessionKey?: string;
};

export type SessionEventOptions = {
  agentId: string;
  sessionKey: string;
  source: SessionEventSource;
  contextKey?: string;
  /** Stable identity for durable host producers across restart handoffs. */
  sourceTurnId?: string;
  /** Run that started the producer's work; a provenance fact for this turn, never authority. */
  sourceRunId?: string;
  deliveryContext?: DeliveryContext;
  abortSignal?: AbortSignal;
  expectedTarget?: SessionEventTarget;
  /** Authorized fresh work may create an absent session; captured completions may not. */
  createIfMissing?: true;
  /** Submitting invocation custody lasts through acceptance only. */
  assertAcceptanceCurrent?: () => void;
  /** Durable producer commits its attempt only after normal turn adoption. */
  onAdopted?: () => void | Promise<void>;
  /** Transfer exact queued occurrences into one ordinary turn without duplicating them. */
  occurrences?: readonly SystemEvent[];
  scheduledAutomation?: ScheduledSessionAutomation;
  /** Failed promotion retains an existing passive occurrence until ordinary adoption begins. */
  preserveOccurrenceOnRejection?: true;
  /** Internal: policy-change re-admission depth, bounded to stop publication storms. */
  readmissionAttempt?: number;
  /** An explicitly silent source records its result without transport delivery. */
  deliver?: boolean;
  /** Host producer remains live through admission, execution and delivery. */
  assertCurrent?: () => void;
};

export type SessionEventSourcePolicy = Readonly<
  Pick<SessionEventTarget, "toolsAllow" | "settings">
>;

/** Cron-owned snapshot and live occurrence fence shared with ordinary reply admission. */
export type ScheduledSessionAutomation = {
  job: CronStoredJob;
  /** The occurrence the cron service admitted; the turn's run admission mints from it. */
  occurrence: import("../../cron/scheduled-occurrence.js").ScheduledOccurrence;
  /** Selected with this admission's config and session; never persisted on the job. */
  modelFallbackPolicy?: {
    useSubagentFallbacks: boolean;
    inheritDefaultFallbacksForAgentStringModel: boolean;
  };
  operatorAuthority?: AdmittedRunOperatorAuthority;
  /** Original Control UI admin classification, revalidated by the restored operator source. */
  controlUiAdmin?: true;
  admissionSource: NonNullable<AdmittedRunContext["admissionSource"]>;
  executionIdentity?: import("../../cron/service/state.js").CronExecutionIdentityAdmission;
  deliveryAttemptFence?:
    | import("../../cron/delivery-attempt-fence.js").CronCompletionDeliveryFence
    | null;
  assertCurrent: () => void;
  /** Refresh durable occurrence authority before admission or an asynchronous effect. */
  prepare?: () => Promise<void>;
  /** Rebuild source wrapping with the config selected for each admission attempt. */
  preparePrompt?: (cfg: OpenClawConfig) => Promise<string>;
  /** Selected absent notices share the receiver's exact ordinary creation operation. */
  bindSessionCreation?: (operation: SessionEntryCreationOperation) => () => void;
  beforeStart?: (
    operation?: ReplyOperationObservation,
  ) => boolean | NonNullable<CronRunOutcome["admissionDeferredReason"]>;
  /** Retain an on-exit occurrence until existing foreground work settles. */
  waitForIdle?: (signal?: AbortSignal, operation?: ReplyOperationObservation) => Promise<void>;
  onStarted?: () => void;
  onLaneWait?: (info: { waiting: boolean }) => void;
  onExecutionStarted?: (info: {
    runId: string;
    sessionId?: string;
    sessionKey: string;
    provider?: string;
    model?: string;
    isFallback?: boolean;
  }) => void;
  onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
  beforeDeliver?: () => Promise<void>;
  assertDeliveryCurrent?: () => void;
  sourceDelivery?: SourceDeliveryPlan;
  finalizePromptForResolvedTools?: ResolvedToolPromptFinalizer;
};

/** Producer callbacks stay bound to the queued occurrence, not a later dispatcher. */
export type SessionEventExecution = {
  /** Admit the prepared input to the occurrence's durable custody before queueing. */
  prepareInput?: (recorder: UserTurnTranscriptRecorder) => Promise<void>;
  /** Original command custody survives process eviction and deferred reply execution. */
  execRequestOwners?: readonly ExecRequestOwner[];
  /** Background producers inherit this turn's automatic-delivery restriction. */
  deliver?: false;
  /** Captured producer and current session policy remain authoritative at final tool I/O. */
  assertCurrent?: () => void;
  /** Bind the original absent target to the normal session writer before its first commit. */
  bindSessionCreation?: (operation: SessionEntryCreationOperation) => () => void;
  beforeStart?: () => Promise<void>;
  /** Scheduled source admission precedes native preparation and lifecycle start. */
  beforeScheduledStart?: (runId: string) => Promise<void>;
  onFailed?: (error: unknown) => void;
  onSuppressed?: (
    reason: "send-policy" | "room-event" | "silent" | "message-tool-only" | "aborted",
  ) => void;
  onStarted: (runId: string) => void;
  onTerminal: (
    runId: string,
    outcome: "completed" | "failed" | "aborted",
    deliveryEvidence?: {
      didSendViaMessagingTool?: boolean;
      messagingToolSentTargets?: MessagingToolSend[];
      meta?: EmbeddedAgentRunMeta;
      payloads?: EmbeddedAgentRunPayload[];
      resolved?: { provider: string; model: string };
    },
  ) => void | Promise<void>;
};
