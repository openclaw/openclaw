import type { QueueMode } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import type { CronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
import type { ReplyDeliveryObserver } from "../../agents/reply-completion.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import type { SessionEntry, SessionToolOverrides } from "../../config/sessions/types.js";
// Shared get-reply type contracts for command, directive, and runtime layers.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DashboardMessageReadAdmission } from "../../gateway/message-action-turn-capability.js";
import type { ExtractedFileImage } from "../../media-understanding/extracted-file-images.js";
import type { PluginCommandReplyOptions } from "../../plugins/plugin-command-dispatch-contract.js";
import type { SkillWorkshopProposalRevisionConstraint } from "../../skills/workshop/types.js";
import { captureChannelOperatorRunAuthority } from "../command-owner-authority.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { CommandSessionMetadataChange } from "./command-session-metadata.js";
import type { PreparedReplyConversation } from "./prompt-session-context.js";
import type { FollowupQueueDisposition, QueuedFollowupReplyDelivery } from "./queue/types.js";
import type { ReplyOptionsWithAdmissionTicket } from "./reply-admission-ticket.js";
import type { ReplyOptionsWithOperationRunState } from "./reply-operation-run-state.js";
import type { ReplyOperation } from "./reply-run-registry.js";

export type ReplySessionBinding = {
  sessionKey?: string;
  sessionId: string;
  lifecycleRevision?: string;
  storePath?: string;
};

export type PendingContinuationSettlement = {
  settle: (statusDelivered: boolean) => Promise<void>;
};

export type ReplyRunVerbosity = {
  verboseLevelOverride?: VerboseLevel;
  resolvedVerboseLevel: VerboseLevel;
};

type InternalReplySessionOptions = {
  /** One accepted request owns this monotonic custody budget across dispatch attempts. */
  stateAcquisitionDeadline?: () => number;
  /** Host-minted original operator authority; never restored from session metadata. */
  operatorAuthority?: AdmittedRunOperatorAuthority;
  extractedFileImages?: ExtractedFileImage[];
  /** Rechecks the live Gateway caller before a chat login has a durable effect. */
  assertProviderLoginAuthority?: () => void;
  getProviderLoginConfig?: () => OpenClawConfig;
  /** Invocation-owned conversation facts; never execution or sender authority. */
  replyConversation?: PreparedReplyConversation;
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  /** Internal delivery owner that stages reply media using current Gateway session policy. */
  mediaNormalizationOwner?: "gateway";
  /** Exact authority-bearing settings captured by Gateway chat admission. */
  admittedSessionSettings?: Readonly<Pick<SessionEntry, "permissionMode" | "toolOverrides">>;
  /** Host-stamped exact-run capability for late Codex creator-authority capture. */
  cronCreatorAuthorityCapability?: CronCreatorAuthorityCapability;
  /** Current external dashboard turn only; never persisted or inherited by another run. */
  dashboardReadAdmission?: DashboardMessageReadAdmission;
  expectedExistingSessionId?: string;
  /** Retained predecessor evidence; reply admission must verify its session lineage and store. */
  expectedActiveReplyOperation?: ReplyOperation;
  /** First dispatch only: admission created this exact pinned session before reply initialization. */
  newlyCreatedSessionId?: string;
  onDeliberateSilentTerminalReply?: () => void;
  /** Source-specific final delivery, e.g. a committed answer in the current WebChat history. */
  resolveReplyDelivery?: ReplyDeliveryObserver;
  /** Retire the run's bundle MCP runtime at settlement. Set by one-shot isolated runs (isolated heartbeats) whose session ID is never reused. */
  cleanupBundleMcpOnRunEnd?: boolean;
  /** Defers the child-completion wake until the visible waiting status is delivered. */
  onPendingContinuation?: (settlement?: PendingContinuationSettlement) => void;
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
  onSessionMetadataChanges?: (changes: CommandSessionMetadataChange[]) => void;
  /** Publishes each executing turn's preferences without persisting them to its session. */
  onRunVerbosityResolved?: (settings: ReplyRunVerbosity) => void;
  /** Prevent implicit rollover after a caller has durably admitted this exact session. */
  pinExpectedExistingSession?: boolean;
  requestedSessionId?: string;
  resumeRequestedSession?: boolean;
  sessionPromptSourceReplyDeliveryMode?: GetReplyOptions["sourceReplyDeliveryMode"];
  /** Receives terminal queue-cap outcomes without widening the public reply API. */
  onFollowupQueueDisposition?: (disposition: FollowupQueueDisposition) => void;
  /** Delivers queued replies only through their originating Gateway admission. */
  onQueuedFollowupReplyBatch?: QueuedFollowupReplyDelivery;
  /** Overrides persisted queue mode for this reply only. */
  queueModeOverride?: QueueMode;
  /** Dispatch-owned operation used to defer hooks until durable run admission. */
  replyOperation?: ReplyOperation;
  skillOverrides?: SessionToolOverrides["skills"];
  /** Gateway-private optimistic-concurrency constraint for an operator-requested proposal revision. */
  skillWorkshopProposalRevision?: SkillWorkshopProposalRevisionConstraint;
  skillLibraryAuthoring?: import("../../skills/library/authoring.js").SkillLibraryAuthoringCapability;
};

export type InternalGetReplyOptions = GetReplyOptions &
  PluginCommandReplyOptions &
  InternalReplySessionOptions &
  ReplyOptionsWithOperationRunState &
  ReplyOptionsWithAdmissionTicket;

/** One reply invocation captures and releases its source; queued work retains its own hold. */
export function withReplyOperatorAuthority<Context extends MsgContext>(
  resolveReply: (
    ctx: Context,
    opts: InternalGetReplyOptions | undefined,
    configOverride: OpenClawConfig | undefined,
  ) => Promise<ReplyPayload | ReplyPayload[] | undefined>,
) {
  return async (ctx: Context, supplied?: GetReplyOptions, configOverride?: OpenClawConfig) => {
    const { operatorAuthority, ...options }: InternalGetReplyOptions = supplied ?? {};
    if (operatorAuthority !== undefined) {
      assertAdmittedRunOperatorAuthority(operatorAuthority);
      operatorAuthority.assertCurrent();
    }
    const channel =
      !operatorAuthority &&
      !options.isHeartbeat &&
      ctx.InternalTurnSource === undefined &&
      (!ctx.InputProvenance || ctx.InputProvenance.kind === "external_user")
        ? captureChannelOperatorRunAuthority(ctx)
        : undefined;
    try {
      return await resolveReply(
        ctx,
        supplied || channel
          ? { ...options, operatorAuthority: operatorAuthority ?? channel?.authority }
          : undefined,
        configOverride,
      );
    } finally {
      channel?.release();
    }
  };
}

export function withExtractedFileImages(
  opts: InternalGetReplyOptions | undefined,
  extractedFileImages: ExtractedFileImage[] | undefined,
): InternalGetReplyOptions | undefined {
  if (!extractedFileImages || extractedFileImages.length === 0) {
    return opts;
  }
  return {
    ...opts,
    extractedFileImages: [...(opts?.extractedFileImages ?? []), ...extractedFileImages],
  };
}

export function shouldBridgeCliPreambleEvents(opts: InternalGetReplyOptions | undefined): boolean {
  return opts?.commentaryProgressEnabled === true || opts?.progressPreambleEnabled === true;
}

/** Reply resolver signature used by dispatchers and tests for dependency injection. */
export type GetReplyFromConfig = (
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
) => Promise<ReplyPayload | ReplyPayload[] | undefined>;

export type InternalGetReplyFromConfig = (
  ctx: MsgContext,
  opts?: InternalGetReplyOptions,
  configOverride?: OpenClawConfig,
) => Promise<ReplyPayload | ReplyPayload[] | undefined>;
