import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { CurrentInboundPromptContext } from "../agents/internal-runtime-context.js";
import type { ReplyExpectation } from "../agents/reply-completion.types.js";
import type { RequesterOrigin } from "../agents/requester-origin.js";
import type { ScheduledToolPolicyContext } from "../agents/scheduled-tool-policy.js";
import type { TrustedSubagentCompletionHandoff } from "../agents/subagents/announce/subagent-announce-handoff.js";
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
import type { OriginatingChannelType } from "../auto-reply/templating.js";
import type { ChatType } from "../channels/chat-type.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GroupToolPolicyConfig } from "../config/types.tools.js";
import type { GatewayUiCommandTarget } from "../gateway/ui-command-target.types.js";
import type { ImageContent } from "../llm/types.js";
import type { MediaFact } from "../media/media-facts.js";
import type { PromptImageOrderEntry } from "../media/prompt-image-order.js";
import type { RuntimePluginToolGrant } from "../plugins/runtime/tool-grant.js";
import type { InputProvenance } from "./input-provenance.js";
import type { ReplyBackendTurnStatus } from "./session-controller.turn-status.types.js";
import type { UserTurnTranscriptRecorder } from "./user-turn-transcript.types.js";

export type ReplyBackendCancelReason = "user_abort" | "restart" | "superseded";

export type ReplyBackendQueueMessageOptions = {
  /** Prepared context for this queue item, separate from its transcript and answer text. */
  currentInboundContext?: CurrentInboundPromptContext;
  steeringMode?: "all";
  /** True when this queue item came from the channel's current user turn. */
  isInboundUserMessage?: boolean;
  /** Host-captured human reply identity, independent of pending-question eligibility. */
  isInboundUserReply?: boolean;
  /** User-authorized controls retain sender authority but are not answers to pending questions. */
  allowPendingUserInputAnswer?: false;
  terminalReplyExpectation?: ReplyExpectation;
  /** Exact tool authority resolved for an inbound user turn before steering. */
  toolAuthorityFingerprint?: string;
  /** Internal proof that a mismatched route recomputes to the active run's full authority. */
  pendingInputAuthorityFingerprint?: string;
  debounceMs?: number;
  /** Ordered current-turn images to inject with the steering text. */
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  /** Ordered facts represented by attachment text in this steering prompt. */
  media?: MediaFact[];
  deliveryTimeoutMs?: number;
  waitForTranscriptCommit?: boolean;
  /** Stable source identity for exact queued-message commit/cancellation matching. */
  queueIdentity?: string;
  abortSignal?: AbortSignal;
  /** Releases arrival ordering once the runtime has actually accepted this queue item. */
  onQueueAccepted?: (accepted: boolean) => void;
  /** Releases per-input custody after commit, cancellation, or terminal rejection. */
  onQueueSettled?: () => void;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  /** Prepared channel turn to merge only at transcript persistence. */
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
};

export type ReplyMessageInjectionOptions = ReplyBackendQueueMessageOptions & {
  /** Fresh requester authority checked by the host and never forwarded to the backend. */
  requesterToolAuthority?: ReplyToolAuthorityRequester;
  /** Host admission after policy preparation; false leaves the input for follow-up. */
  canAdmit?: () => boolean;
  toolAuthorityPreparation?: ReplyToolAuthorityPreparation & {
    /** Prepare source text under the selected backend's injection custody. */
    prepareMessage?: () => Promise<string>;
    /** Host policy preparation alone does not add a caller-lifetime binding. */
    authorityKind?: "run" | "source-bound";
  };
  /** Host-observed audio fact; an owner must preserve its dynamic tool context before accepting. */
  inboundAudio?: boolean;
  /** Consumed by reply ownership and never forwarded to the active backend. */
  toolAuthorityOverlay?: ReplyToolAuthorityOverlay;
  /** Normal human ingress may retain the incumbent's policy within the same conversation. */
  allowCollaborativeSteering?: boolean;
  /** Accepted sender facts when the ingress owner already prepared route-specific authority. */
  personalToolParticipant?: ReplyTurnParticipantInput;
  /** Composed into V2's final admission assertion after asynchronous preparation. */
  assertCurrent?: () => void;
};

export type ReplyToolAuthorityRoute = Readonly<{
  provider: string;
  model: string;
}>;

/** Per-message authority facts projected against an active run's frozen owner state. */
export type ReplyToolAuthorityOverlay = Readonly<{
  /** Internal admission decision; never used for explicit cross-session requests. */
  allowCollaborativeSteering?: true;
  sessionKey?: string;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  permissionMode?: SessionEntry["permissionMode"];
  toolOverrides?: SessionEntry["toolOverrides"];
  originatingChannel?: OriginatingChannelType;
  messageProvider?: string;
  chatType?: ChatType;
  agentAccountId?: string;
  conversationToolPolicy?: GroupToolPolicyConfig;
  conversationId?: string;
  messageThreadId?: string | number;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  memberRoleIds?: string[];
  spawnedBy?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  senderIsOwner: boolean;
  /** Attribution carried by the originating request; grants no operator permission. */
  gitContributorProfileId?: string;
  inputProvenance?: InputProvenance;
  trustedInternalHandoff?: TrustedSubagentCompletionHandoff;
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  runtimePluginToolGrant?: RuntimePluginToolGrant;
  toolsAllow?: string[];
  disableTools: boolean;
  traceAuthorized: boolean;
  approvalReviewerDeviceId?: string;
  clientCaps?: string[];
  gatewayUiCommandTarget?: GatewayUiCommandTarget;
  toolBindings?: Readonly<Record<string, unknown>>;
}>;

/** Fresh delegation facts projected at its destination, separate from a source tool ceiling. */
export type ReplyToolAuthorityRequester = Readonly<{
  requesterOrigin: RequesterOrigin;
  config: OpenClawConfig;
}>;

export type ReplyTurnParticipantInput = Pick<
  ReplyToolAuthorityOverlay,
  "operatorAuthority" | "senderId" | "senderName" | "gatewayUiCommandTarget"
> & { requesterOrigin?: RequesterOrigin };

export type ReplyToolAuthoritySnapshot = Readonly<{
  /** Authenticated requester identity, independent of permissions and client reconnections. */
  requesterPrincipalKey?: string;
  close?(): void;
  personalToolOwner?: ReplyTurnParticipantInput;
  /** Selection admitted before runtime fallback or hooks choose a concrete model. */
  requestedRoute?: ReplyToolAuthorityRoute;
  /** @deprecated Use fingerprintAsync for worker-backed preparation. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
  fingerprint(route?: ReplyToolAuthorityRoute): string;
  /** @deprecated Use projectAsync for worker-backed preparation. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
  project: (overlay: ReplyToolAuthorityOverlay, route: ReplyToolAuthorityRoute) => string;
  fingerprintAsync?(route?: ReplyToolAuthorityRoute): Promise<string>;
  projectAsync?(
    overlay: ReplyToolAuthorityOverlay,
    route: ReplyToolAuthorityRoute,
  ): Promise<string>;
  projectRequester?(requester: ReplyToolAuthorityRequester, route: ReplyToolAuthorityRoute): string;
  projectRequesterAsync?(
    requester: ReplyToolAuthorityRequester,
    route: ReplyToolAuthorityRoute,
  ): Promise<string>;
}>;

export type ReplyTurnParticipant = Readonly<{
  profileId: string;
  senderId: string;
  name: string;
  /** Host-issued source; independent children acquire their own custody before turn close. */
  operatorAuthority: AdmittedRunOperatorAuthority;
  requesterOrigin?: RequesterOrigin;
  gatewayUiCommandTarget?: GatewayUiCommandTarget;
  assertCurrent: () => void;
}>;

export type ReplyTurnParticipants = {
  accept(participant: ReplyTurnParticipantInput): void;
  resolve(
    this: void,
    user?: string,
    options?: { allowTurnOwner?: () => boolean },
  ): ReplyTurnParticipant | undefined;
  close(): void;
};

export type ReplyBackendQueueMessageResult = {
  /** Input is non-replayable, but its delivery or commitment could not be confirmed. */
  transcriptCommit: "unconfirmed";
  errorMessage: string;
};

export type ReplyBackendMessageInjection = {
  /** Runtime-owned admission state; independent from token streaming. */
  isAvailable(): boolean;
  queueMessage(
    text: string,
    options?: ReplyBackendQueueMessageOptions,
  ): Promise<void | ReplyBackendQueueMessageResult>;
};

/** V2 sinks invoke the host-owned, per-injection assertion at their final effect. */
export type ReplyToolAuthorityPreparation = {
  assertCurrent(this: void): void;
  prepareCurrent(this: void): Promise<void>;
  /** Pending-question compatibility still checks mutable policy synchronously. */
  compatAssertCurrent(this: void): void;
};

export type ReplyBackendMessageInjectionV2 = {
  readonly version: 2;
  isAvailable(): boolean;
  /** @deprecated Use queueMessageAsync with fresh policy preparation. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
  queueMessage(
    text: string,
    options: ReplyBackendQueueMessageOptions | undefined,
    assertCurrent: () => void,
    authorityKind: "run" | "source-bound",
  ): Promise<void | ReplyBackendQueueMessageResult>;
  queueMessageAsync?(
    text: string,
    options: ReplyBackendQueueMessageOptions | undefined,
    preparation: ReplyToolAuthorityPreparation,
    authorityKind: "run" | "source-bound",
  ): Promise<void | ReplyBackendQueueMessageResult>;
  /** @deprecated Use claimPendingUserInputAnswerAsync with fresh policy preparation. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
  claimPendingUserInputAnswer?(
    text: string,
    options: ReplyBackendQueueMessageOptions | undefined,
    assertCurrent: () => void,
    authorityKind: "run" | "source-bound",
  ): Promise<boolean>;
  claimPendingUserInputAnswerAsync?(
    text: string,
    options: ReplyBackendQueueMessageOptions | undefined,
    preparation: ReplyToolAuthorityPreparation,
    authorityKind: "run" | "source-bound",
  ): Promise<boolean>;
  /** @deprecated Use cancelPendingUserInputAsync with fresh policy preparation. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
  cancelPendingUserInput?(
    resolvedBy: string,
    assertCurrent: () => void,
    authorityKind: "run" | "source-bound",
  ): Promise<boolean>;
  cancelPendingUserInputAsync?(
    resolvedBy: string,
    preparation: ReplyToolAuthorityPreparation,
    authorityKind: "run" | "source-bound",
  ): Promise<boolean>;
};

export type ReplyBackendHandle = {
  readonly kind: "embedded" | "cli";
  readonly runId?: string;
  /** Exact authority of this concrete backend attempt, after fallback selection. */
  readonly toolAuthorityFingerprint?: string;
  readonly sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  readonly terminalReplyExpectation?: ReplyExpectation;
  /** The sink records a human reply obligation only upon accepted steering. */
  readonly supportsUserReplyPromotion?: boolean;
  readonly taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  /** True only when queueMessage preserves images supplied in its options. */
  readonly supportsQueueMessageImages?: boolean;
  /** True only when queueMessage can hold its receipt until the transcript commit. */
  readonly supportsTranscriptCommitWait?: boolean;
  /** False keeps inbound steering with the turn owner's profile; omission permits other profiles. */
  readonly supportsCrossProfileSteering?: boolean;
  claimPendingUserInputAnswer?: (
    text: string,
    options?: ReplyBackendQueueMessageOptions,
  ) => Promise<boolean>;
  cancelPendingUserInput?: (resolvedBy: string) => Promise<boolean>;
  cancel(reason?: ReplyBackendCancelReason): void;
  readonly messageInjection?: ReplyBackendMessageInjection;
  /** V1 remains compatible with v2026.8.1; source-bound input requires V2. */
  readonly messageInjectionV2?: ReplyBackendMessageInjectionV2;
  /** @deprecated Compatibility for shipped embedded handles. Use messageInjection. */
  isStreaming?: () => boolean;
  isStopped?: () => boolean;
  /** True after this backend accepted an abort, even while its cleanup is retained. */
  isAborted?: () => boolean;
  isAbortable?: () => boolean;
  /** Recover a stalled model request while retaining this native turn for fallback. */
  recoverStalledModelCall?: () => boolean;
  /** Stable within one registration; re-read identity because it can be replaced or cleared. */
  readonly turnStatus?: ReplyBackendTurnStatus;
  /** @deprecated Compatibility for shipped embedded handles. Use messageInjection. */
  queueMessage?: ReplyBackendMessageInjection["queueMessage"];
  /**
   * Compatibility-only hook so legacy "abort compacting runs" paths can still
   * find embedded runs that are compacting during the main run phase.
   */
  isCompacting?: () => boolean;
};

export type ReplyMessageInjectionResolution =
  | {
      reason: ReplyMessageInjectionRejectionReason;
      errorMessage?: string;
      backend?: ReplyBackendHandle;
      cancelPendingUserInput?: ReplyBackendHandle["cancelPendingUserInput"];
    }
  | {
      backend: ReplyBackendHandle;
      injection: ReplyBackendMessageInjection;
      /** Internal FIFO preflight for a released synchronous sink. */
      prepareQueueMessage?: () => Promise<void>;
    };

export type ReplyMessageInjectionRejectionReason =
  | "no_active_run"
  | "not_running"
  | "stale_run"
  | "injection_unavailable"
  | "guarded_injection_unsupported"
  | "requester_origin_mismatch"
  | "audio_input_unsupported"
  | "collaborative_steering_disabled"
  | ReplyBackendQueueMessageMismatch
  | "runtime_rejected";

export type ReplyBackendQueueMessageMismatch =
  | "transcript_commit_wait_unsupported"
  | "input_visibility_mismatch"
  | "tool_authority_mismatch"
  | "image_input_unsupported"
  | "source_reply_delivery_mode_mismatch"
  | "reply_expectation_mismatch"
  | "task_suggestion_delivery_mode_mismatch";
