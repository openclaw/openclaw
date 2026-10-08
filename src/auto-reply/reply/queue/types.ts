import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { AdmittedRunOperatorAuthority } from "../../../agents/admitted-run-context.js";
import type { AutoFallbackPrimaryProbe } from "../../../agents/agent-scope.js";
import type { ExecToolDefaults } from "../../../agents/bash-tools.js";
import type { CliSessionBindingFacts } from "../../../agents/cli-runner/session-binding.types.js";
import type {
  CurrentInboundPromptContext,
  RunEmbeddedAgentParams,
} from "../../../agents/embedded-agent-runner/run/params.js";
import type { ModelFallbackRouteResolution } from "../../../agents/model-fallback.types.js";
import type { ReplyDeliveryObserver } from "../../../agents/reply-completion.js";
import type { InboundEventKind } from "../../../channels/inbound-event/kind.js";
import type { ChannelAdmissionEvidence } from "../../../channels/message-access/admission-evidence.js";
import type { SessionEntry } from "../../../config/sessions.js";
import type { PrepareAssistantTranscriptMessage } from "../../../config/sessions/transcript-assistant-delivery.js";
import type { ReplyToMode } from "../../../config/types.base.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { QueueDropPolicy } from "../../../config/types.queue.js";
import type { GatewayLocalUserIngress } from "../../../gateway/local-user-ingress.js";
import type { MediaFact } from "../../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import type { ExplicitSkillSelection } from "../../../skills/types.js";
import type {
  GetReplyOptions,
  QueuedReplyDeliveryCorrelation,
  TurnAdoptionLifecycle,
} from "../../get-reply-options.types.js";
import type { ReplyPayload } from "../../reply-payload.js";
import type { OriginatingChannelType } from "../../templating.js";
import type { ThinkingCatalogEntry } from "../../thinking.js";
import type { ElevatedLevel, ThinkLevel, TraceLevel, VerboseLevel } from "../directives.js";
import type { ReplyOperationRunState } from "../reply-operation-run-state.js";

export type { QueueDropPolicy } from "../../../config/types.queue.js";

export type QueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};

export type ResolveQueueSettingsParams = {
  cfg: OpenClawConfig;
  channel?: string;
  sessionEntry?: SessionEntry;
  inlineMode?: QueueMode;
  inlineOptions?: Partial<QueueSettings>;
  pluginDebounceMs?: number;
};

export type QueueDedupeMode = "message-id" | "none";

type QueueInsertPosition = "tail" | "front";

export type EnqueueFollowupRunOptions = {
  position?: QueueInsertPosition;
  steerCandidate?: boolean;
};

export type FollowupQueueDisposition = "queue-cap" | "queue-cap-old" | "queue-cap-new";

export type QueuedFollowupReplyBatch = {
  kind: "queued-followup";
  runId: string;
  originatingChannel: string | undefined;
  payloads: ReplyPayload[];
  completion:
    | { kind: "progress" }
    | { kind: "completed"; stopReason?: string; allowCanvasOnly?: true }
    | { kind: "failed"; error: string; stopReason?: string; errorKind?: "timeout" }
    | { kind: "aborted"; stopReason?: string };
};

export type QueuedFollowupReplyDelivery = ((
  batch: QueuedFollowupReplyBatch,
) => Promise<void> | void) & {
  ownsCompletion?: (originatingChannel: string | undefined) => boolean;
  createSourceRetry?: () => QueuedFollowupReplyDelivery;
};

type QueuedFollowupReplyDisposition =
  | { kind: "deliver"; deliver: QueuedFollowupReplyDelivery }
  | { kind: "drop"; reason: "source-unavailable" };

export class FollowupRunDeferredError extends Error {
  constructor(message = "Follow-up run deferred") {
    super(message);
    this.name = "FollowupRunDeferredError";
  }
}

// Leaf contracts only: get-reply.types.ts imports this module.
type FollowupRunObservers = Pick<
  GetReplyOptions,
  "onAgentRunStart" | "onAgentRunTerminalOutcome" | "onModelSelected"
> & {
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  resolveReplyDelivery?: ReplyDeliveryObserver;
};

export type FollowupRun = {
  /** External-turn eligibility; queued execution refreshes the session-selected profile. */
  personalBootstrapEligible?: boolean;
  prompt: string;
  /** Original admitted source; queued execution must not replace it with a backend run ID. */
  sourceTurnId?: string;
  /** Original operator capability retained by this turn's queue/run lifecycle. */
  operatorAuthority?: AdmittedRunOperatorAuthority;
  /**
   * Source turn's trusted owner status for memory audience resolution only. System-owned
   * maintenance copies keep `run.senderIsOwner: false`, so they never gain owner tool authority.
   */
  memoryAudienceSenderIsOwner?: boolean;
  /** Latest session to claim without rewriting the queued run before store refresh. */
  admissionSessionId?: string;
  /** User-visible prompt body persisted to transcript; excludes runtime-only prompt context. */
  transcriptPrompt?: string;
  /** Shared lifecycle owner for the current user-turn transcript append. */
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
  currentInboundEventKind?: InboundEventKind;
  /** Whether the current inbound message contained audio for inbound-only TTS policy. */
  currentInboundAudio?: boolean;
  /** Host-minted participant evidence; raw channel identities never live on this object. */
  channelAdmissionEvidence?: ChannelAdmissionEvidence;
  /** Frozen original attach evidence; diagnostic only and never restored from durable queue state. */
  gatewayLocalUserIngress?: GatewayLocalUserIngress;
  /** Explicit current-turn context that should be visible for this run but not persisted as user text. */
  currentInboundContext?: CurrentInboundPromptContext;
  /** Explicit skills resolved from the authenticated inbound message. */
  explicitSkillSelections?: ExplicitSkillSelection[];
  /** Abort signal for turns that are canceled by their source-channel admission fence. */
  abortSignal?: AbortSignal;
  /** Queue-owned cancellation fence used when lifecycle cleanup invalidates pending work. */
  queueAbortSignal?: AbortSignal;
  deliveryCorrelations?: QueuedReplyDeliveryCorrelation[];
  /** Canonical ownership lifecycle for durable ingress / reply-lane transfer. */
  turnAdoptionLifecycle?: TurnAdoptionLifecycle;
  /** @internal Source execution receipts retained across queued collect batches. */
  replyOperationRunStates?: ReplyOperationRunState[];
  /** Records terminal queue-cap outcomes at the queue owner before lifecycle cleanup. */
  onQueueDisposition?: (disposition: FollowupQueueDisposition) => void;
  /** Keep delivery bound to the source that owned admission, not later runner defaults. */
  queuedFollowupReplyDisposition?: QueuedFollowupReplyDisposition;
  /** Run-lifecycle observers bound to the source request; the drain's runner may belong to another turn. */
  runObservers?: FollowupRunObservers;
  /** Provider message ID, when available (for deduplication). */
  messageId?: string;
  summaryLine?: string;
  /** Turn-owned tool authority captured before queue ownership transfers. */
  toolsAllow?: string[];
  disableTools?: boolean;
  /** Force individual drain; never merge this run into a collect batch. */
  disableCollectBatching?: boolean;
  /** Pending same-turn acceptance while this item remains parked in FIFO order. */
  steerPending?: {
    phase: "waiting" | "injecting";
    predecessor: Promise<boolean>;
    settle: (accepted: boolean) => void;
  };
  /** Internal marker for the one-shot stranded final recovery retry. */
  strandedReplyRetry?: boolean;
  /** This continuation owes last-resort feedback if it also stalls, including claimed input. */
  stalledTurnRecovery?: boolean;
  /** Preserve priority runs when old-item queue overflow eviction runs before drain. */
  protectFromQueueOverflow?: boolean;
  enqueuedAt: number;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  imageOrder?: PromptImageOrderEntry[];
  /** Ordered facts represented by attachment text in this prompt. */
  media?: MediaFact[];
  /**
   * Originating channel for reply routing.
   * When set, replies should be routed back to this provider
   * instead of using the session's lastChannel.
   */
  originatingChannel?: OriginatingChannelType;
  /**
   * Originating destination for reply routing.
   * The chat/channel/user ID where the reply should be sent.
   */
  originatingTo?: string;
  /** Transport-native chat/conversation ID for hook identity context. */
  originatingChatId?: string;
  /** Provider account id (multi-account). */
  originatingAccountId?: string;
  /** Thread id for reply routing (Telegram topic id or Matrix thread event id). */
  originatingThreadId?: string | number;
  /** Provider reply target for transports that model threads as message replies. */
  originatingReplyToId?: string;
  /** Effective reply policy for deciding whether the reply target affects queued delivery. */
  originatingReplyToMode?: ReplyToMode;
  /** Chat type for context-aware threading (e.g., DM vs channel). */
  originatingChatType?: string;
  run: Pick<
    RunEmbeddedAgentParams,
    | "providerReviewAcknowledgment"
    | "sessionId"
    | "sessionKey"
    | "messageProvider"
    | "clientCaps"
    | "bootstrapUserProfileId"
    | "gatewayUiCommandTarget"
    | "toolBindings"
    | "chatType"
    | "agentAccountId"
    | "conversationRoutePeerId"
    | "conversationToolPolicy"
    | "memberRoleIds"
    | "channelContext"
    | "senderIsOwner"
    | "approvalReviewerDeviceId"
    | "workspaceDir"
    | "cwd"
    | "permissionMode"
    | "sessionRoot"
    | "toolOverrides"
    | "skillsSnapshot"
    | "modelSelectionLocked"
    | "authProfileId"
    | "authProfileIdSource"
    | "thinkLevel"
    | "fastMode"
    | "fastModeAutoOnSeconds"
    | "verboseLevel"
    | "reasoningLevel"
    | "timeoutMs"
    | "runTimeoutOverrideMs"
    | "ownerNumbers"
    | "inputProvenance"
    | "trustedInternalHandoff"
    | "scheduledToolPolicy"
    | "runtimePluginToolGrant"
    | "extraSystemPrompt"
    | "sourceReplyDeliveryMode"
    | "taskSuggestionDeliveryMode"
    | "silentReplyPromptMode"
    | "enforceFinalTag"
    | "silentExpected"
    | "terminalReplyExpectation"
    | "suppressNextUserMessagePersistence"
    | "suppressTranscriptOnlyAssistantPersistence"
    | "skillLibraryAuthoring"
  > & {
    agentId: string;
    agentDir: string;
    runtimePolicySessionKey?: string;
    /** Prepared source delivery ownership; a lost source must not restore host media reads. */
    mediaNormalizationOwner?: "gateway";
    groupId?: string;
    groupChannel?: string;
    groupSpace?: string;
    /** Parent session provenance used to validate inherited group policy. */
    spawnedBy?: string;
    senderId?: string;
    senderName?: string;
    senderUsername?: string;
    senderE164?: string;
    traceAuthorized?: boolean;
    /** Inline choice stays on this run; omission follows the live session preference. */
    traceLevelOverride?: TraceLevel;
    sessionFile: string;
    config: OpenClawConfig;
    provider: string;
    model: string;
    requestedRouteResolution?: ModelFallbackRouteResolution;
    hasSessionModelOverride?: boolean;
    modelOverrideSource?: "auto" | "user";
    hasAutoFallbackProvenance?: boolean;
    /** Session belongs to a spawn-owned child; applies the subagent fallback ladder. */
    subagentSpawnLineage?: boolean;
    autoFallbackPrimaryProbe?: AutoFallbackPrimaryProbe;
    /** Prepared model metadata reused when fallbacks revalidate the immutable thinking request. */
    thinkingCatalog?: ThinkingCatalogEntry[];
    /** Original turn request; model retargeting changes only the effective thinkLevel. */
    readonly thinkLevelOverride?: ThinkLevel | "default";
    fastModeOverride?: boolean;
    fastModeAutoOnSecondsOverride?: boolean;
    /** Explicit turn choice; absent queued replies follow live session verbosity. */
    verboseLevelOverride?: VerboseLevel;
    elevatedLevel?: ElevatedLevel;
    execOverrides?: Pick<ExecToolDefaults, "host" | "security" | "ask" | "node" | "nodeCwd">;
    bashElevated?: {
      enabled: boolean;
      allowed: boolean;
      defaultLevel: ElevatedLevel;
    };
    blockReplyBreak: "text_end" | "message_end";
    extraSystemPromptStatic?: string;
    cliSessionBindingFacts?: CliSessionBindingFacts;
    skipProviderRuntimeHints?: boolean;
  };
};

export function isFollowupRunAborted(
  run: Pick<FollowupRun, "abortSignal" | "queueAbortSignal" | "operatorAuthority">,
): boolean {
  return (
    run.abortSignal?.aborted === true ||
    run.queueAbortSignal?.aborted === true ||
    run.operatorAuthority?.signal?.aborted === true
  );
}

export function resolveFollowupAbortSignal(
  run: Pick<FollowupRun, "abortSignal" | "queueAbortSignal" | "operatorAuthority">,
): AbortSignal | undefined {
  const signals = [run.abortSignal, run.queueAbortSignal, run.operatorAuthority?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}
