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
import type { PreparedTtsPreferences } from "../../tts/tts-preferences.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
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
import type {
  ScheduledSessionAutomation,
  SessionEventExecution,
} from "./session-event-contract.js";

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
  /** One-shot model selection for host-owned turns; never persisted as a user preference. */
  modelOverride?: string;
  /** Host-owned scheduling authority retained through ordinary session execution. */
  scheduledAutomation?: ScheduledSessionAutomation;
  /** Producer callbacks follow this occurrence through queueing and delivery. */
  internalEventExecution?: SessionEventExecution;
  /** Source-owned cancellation retained when dispatch borrows an active lane for queued followups. */
  queuedFollowupAbortSignal?: AbortSignal;
  /** Host-minted original operator authority; never restored from session metadata. */
  operatorAuthority?: AdmittedRunOperatorAuthority;
  extractedFileImages?: ExtractedFileImage[];
  /** Rechecks the live Gateway caller before a chat login has a durable effect. */
  assertProviderLoginAuthority?: () => void;
  getProviderLoginConfig?: () => OpenClawConfig;
  /** Invocation-owned conversation facts; never execution or sender authority. */
  replyConversation?: PreparedReplyConversation;
  preparedTtsPreferences?: PreparedTtsPreferences;
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
  /** Retire the run's bundle MCP runtime at settlement for one-shot sessions. */
  cleanupBundleMcpOnRunEnd?: boolean;
  /** Defers the child-completion wake until the visible waiting status is delivered. */
  onPendingContinuation?: (settlement?: PendingContinuationSettlement) => void;
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
  /** Observes one transcript-start reader preparation; completion cannot control the run. */
  onTranscriptStartPreparation?: () => (() => void) | undefined;
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
  /** Return true only when the caller accepts settlement custody for this exact operation. */
  onReplyOperationOwned?: (operation: ReplyOperation) => boolean | void;
  skillOverrides?: SessionToolOverrides["skills"];
  skillLibraryAuthoring?: import("../../skills/library/authoring.js").SkillLibraryAuthoringCapability;
};

export type InternalGetReplyOptions = GetReplyOptions &
  PluginCommandReplyOptions &
  InternalReplySessionOptions &
  ReplyOptionsWithOperationRunState &
  ReplyOptionsWithAdmissionTicket;

/** Pin the host-issued source before public options cross asynchronous preparation. */
export function prepareInternalGetReplyOptions(
  opts: GetReplyOptions | undefined,
  context?: MsgContext,
): InternalGetReplyOptions | undefined {
  const channelAuthority = context && getCommandOwnerAuthority(context)?.operatorAuthority;
  if (!opts && !channelAuthority) {
    return undefined;
  }
  const { operatorAuthority = channelAuthority, ...options }: InternalGetReplyOptions = opts ?? {};
  if (operatorAuthority !== undefined) {
    assertAdmittedRunOperatorAuthority(operatorAuthority);
    operatorAuthority.assertCurrent();
  }
  return { ...options, operatorAuthority };
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

type ReplyResolver<Options extends GetReplyOptions> = (
  ctx: MsgContext,
  opts?: Options,
  configOverride?: OpenClawConfig,
) => Promise<ReplyPayload | ReplyPayload[] | undefined>;

/** Reply resolver signature used by dispatchers and tests for dependency injection. */
export type GetReplyFromConfig = ReplyResolver<GetReplyOptions>;
export type InternalGetReplyFromConfig = ReplyResolver<InternalGetReplyOptions>;
