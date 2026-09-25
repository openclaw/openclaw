import type { FastMode } from "@openclaw/normalization-core/string-coerce";
// Shared queue type contracts for admission, drain, and fallback handling.
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { AdmittedRunOperatorAuthority } from "../../../agents/admitted-run-context.js";
import type { AutoFallbackPrimaryProbe } from "../../../agents/agent-scope.js";
import type { ExecToolDefaults } from "../../../agents/bash-tools.js";
import type { CliSessionBindingFacts } from "../../../agents/cli-runner/types.js";
import type {
  CurrentInboundPromptContext,
  RunEmbeddedAgentParams,
} from "../../../agents/embedded-agent-runner/run/params.js";
import type { ModelFallbackRouteResolution } from "../../../agents/model-fallback.types.js";
import type { ScheduledToolPolicyContext } from "../../../agents/scheduled-tool-policy.js";
import type { TrustedSubagentCompletionHandoff } from "../../../agents/subagents/announce/subagent-announce-handoff.js";
import type { SilentReplyPromptMode } from "../../../agents/system-prompt.types.js";
import type { ChatType } from "../../../channels/chat-type.js";
import type { InboundEventKind } from "../../../channels/inbound-event/kind.js";
import type { ChannelAdmissionEvidence } from "../../../channels/message-access/admission-evidence.js";
import type { SessionEntry, SessionToolOverrides } from "../../../config/sessions.js";
import type { ReplyToMode } from "../../../config/types.base.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { GroupToolPolicyConfig } from "../../../config/types.tools.js";
import type { GatewayUiCommandTarget } from "../../../gateway/ui-command-target.types.js";
import type { MediaFact } from "../../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import type { PluginHookChannelContext } from "../../../plugins/hook-types.js";
import type { RuntimePluginToolGrant } from "../../../plugins/runtime/tool-grant.js";
import type { InputProvenance } from "../../../sessions/input-provenance.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import type { ExplicitSkillSelection, SkillSnapshot } from "../../../skills/types.js";
import type { SkillWorkshopProposalRevisionConstraint } from "../../../skills/workshop/types.js";
import type {
  QueuedReplyDeliveryCorrelation,
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
  TurnAdoptionLifecycle,
} from "../../get-reply-options.types.js";
import type { ReplyPayload } from "../../reply-payload.js";
import type { OriginatingChannelType } from "../../templating.js";
import type { ThinkingCatalogEntry } from "../../thinking.js";
import type {
  ElevatedLevel,
  ReasoningLevel,
  ThinkLevel,
  TraceLevel,
  VerboseLevel,
} from "../directives.js";
import type { ReplyOperationRunState } from "../reply-operation-run-state.js";

export type QueueDropPolicy = "old" | "new" | "summarize";

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

export function isFollowupRunDeferredError(error: unknown): error is FollowupRunDeferredError {
  return error instanceof FollowupRunDeferredError;
}

export type FollowupRun = {
  /** External-turn eligibility; queued execution refreshes the session-selected profile. */
  personalBootstrapEligible?: boolean;
  prompt: string;
  /** Original operator capability retained by this turn's queue/run lifecycle. */
  operatorAuthority?: AdmittedRunOperatorAuthority;
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
  /** Provider message ID, when available (for deduplication). */
  messageId?: string;
  summaryLine?: string;
  /** Turn-owned tool authority captured before queue ownership transfers. */
  toolsAllow?: string[];
  disableTools?: boolean;
  /** Force individual drain; never merge this run into a collect batch. */
  disableCollectBatching?: boolean;
  /** The current-turn hook already ran before this steer became a fallback. */
  /** Pending same-turn acceptance while this item remains parked in FIFO order. */
  steerPending?: {
    phase: "waiting" | "injecting";
    predecessor: Promise<boolean>;
    settle: (accepted: boolean) => void;
  };
  /** Preserves this candidate's position ahead of overflow summaries. */
  steerAnchor?: true;
  /** Internal marker for the one-shot stranded final recovery retry. */
  strandedReplyRetry?: boolean;
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
  run: {
    providerReviewAcknowledgment?: import("../../../sessions/provider-review.js").ProviderReviewAcknowledgment;
    agentId: string;
    agentDir: string;
    sessionId: string;
    sessionKey?: string;
    runtimePolicySessionKey?: string;
    messageProvider?: string;
    /** Prepared source delivery ownership; a lost source must not restore host media reads. */
    mediaNormalizationOwner?: "gateway";
    clientCaps?: string[];
    /** Gateway client id for the process that originated this run. */
    clientId?: string;
    bootstrapUserProfileId?: string;
    gatewayUiCommandTarget?: GatewayUiCommandTarget;
    toolBindings?: Readonly<Record<string, unknown>>;
    chatType?: ChatType;
    agentAccountId?: string;
    conversationRoutePeerId?: string;
    conversationToolPolicy?: GroupToolPolicyConfig;
    groupId?: string;
    groupChannel?: string;
    groupSpace?: string;
    memberRoleIds?: string[];
    /** Parent session provenance used to validate inherited group policy. */
    spawnedBy?: string;
    senderId?: string;
    channelContext?: PluginHookChannelContext;
    senderName?: string;
    senderUsername?: string;
    senderE164?: string;
    senderIsOwner?: boolean;
    traceAuthorized?: boolean;
    /** Inline choice stays on this run; omission follows the live session preference. */
    traceLevelOverride?: TraceLevel;
    approvalReviewerDeviceId?: string;
    sessionFile: string;
    workspaceDir: string;
    /** Task working directory for runtime execution. Defaults to workspaceDir. */
    cwd?: string;
    permissionMode?: SessionEntry["permissionMode"];
    sessionRoot?: string;
    config: OpenClawConfig;
    toolOverrides?: SessionToolOverrides;
    skillsSnapshot?: SkillSnapshot;
    provider: string;
    model: string;
    requestedRouteResolution?: ModelFallbackRouteResolution;
    /** Prevents the queued run from selecting configured fallback models. */
    modelSelectionLocked?: boolean;
    hasSessionModelOverride?: boolean;
    modelOverrideSource?: "auto" | "user";
    hasAutoFallbackProvenance?: boolean;
    /** Session belongs to a spawn-owned child; applies the subagent fallback ladder. */
    subagentSpawnLineage?: boolean;
    autoFallbackPrimaryProbe?: AutoFallbackPrimaryProbe;
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
    /** Prepared model metadata reused when fallbacks revalidate the immutable thinking request. */
    thinkingCatalog?: ThinkingCatalogEntry[];
    thinkLevel?: ThinkLevel;
    /** Original turn request; model retargeting changes only the effective thinkLevel. */
    readonly thinkLevelOverride?: ThinkLevel | "default";
    fastMode?: FastMode;
    fastModeAutoOnSeconds?: number;
    fastModeOverride?: boolean;
    fastModeAutoOnSecondsOverride?: boolean;
    verboseLevel?: VerboseLevel;
    /** Explicit turn choice; absent queued replies follow live session verbosity. */
    verboseLevelOverride?: VerboseLevel;
    reasoningLevel?: ReasoningLevel;
    elevatedLevel?: ElevatedLevel;
    execOverrides?: Pick<ExecToolDefaults, "host" | "security" | "ask" | "node" | "nodeCwd">;
    bashElevated?: {
      enabled: boolean;
      allowed: boolean;
      defaultLevel: ElevatedLevel;
    };
    timeoutMs: number;
    runTimeoutOverrideMs?: number;
    blockReplyBreak: "text_end" | "message_end";
    ownerNumbers?: string[];
    inputProvenance?: InputProvenance;
    /** Trusted authority facts that must survive queueing and steering admission. */
    trustedInternalHandoff?: TrustedSubagentCompletionHandoff;
    scheduledToolPolicy?: ScheduledToolPolicyContext;
    runtimePluginToolGrant?: RuntimePluginToolGrant;
    extraSystemPrompt?: string;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
    silentReplyPromptMode?: SilentReplyPromptMode;
    extraSystemPromptStatic?: string;
    cliSessionBindingFacts?: CliSessionBindingFacts;
    enforceFinalTag?: boolean;
    skipProviderRuntimeHints?: boolean;
    silentExpected?: boolean;
    terminalReplyExpectation?: RunEmbeddedAgentParams["terminalReplyExpectation"];
    suppressNextUserMessagePersistence?: boolean;
    suppressTranscriptOnlyAssistantPersistence?: boolean;
    /** Gateway-private optimistic-concurrency constraint for an operator-requested proposal revision. */
    skillWorkshopProposalRevision?: SkillWorkshopProposalRevisionConstraint;
    skillLibraryAuthoring?: import("../../../skills/library/authoring.js").SkillLibraryAuthoringCapability;
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
