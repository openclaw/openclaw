import type { QueueMode } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import type { CronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
import type {
  ReplyDeliveryFactsObserver,
  ReplyDeliveryObserver,
} from "../../agents/reply-completion.js";
import type { SessionEntryCreationCommit } from "../../config/sessions/session-entry-creation.types.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import type { SessionEntry, SessionToolOverrides } from "../../config/sessions/types.js";
// Shared get-reply type contracts for command, directive, and runtime layers.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DashboardMessageReadAdmission } from "../../gateway/message-action-turn-capability.js";
import type { ExtractedFileImage } from "../../media-understanding/extracted-file-images.js";
import type { PluginCommandReplyOptions } from "../../plugins/plugin-command-dispatch-contract.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import type { PreparedTtsPreferences } from "../../tts/tts-preferences.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { CommandSessionMetadataChange } from "./command-session-metadata.js";
import type { PreparedReplyConversation } from "./prompt-session-context.js";
import type { QueuedFollowupReplyDelivery } from "./queue/types.js";
import type { ReplyOptionsWithOperationRunState } from "./reply-operation-run-state.js";
import type { ReplySourceBinding } from "./reply-source-binding.types.js";
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
  /** Accept visible status delivery or an explicit silent handoff; false releases custody. */
  settle: (statusDelivered: boolean) => Promise<void>;
};

export type ReplyRunVerbosity = {
  verboseLevelOverride?: VerboseLevel;
  resolvedVerboseLevel: VerboseLevel;
};

type InternalReplySessionOptions = {
  /** Dispatch-owned command requester binding; never part of the public plugin API. */
  withCommandNativeSubagents?: <T>(
    binding: { agentId: string; sessionKey: string; entry: SessionEntry },
    run: (
      create:
        | import("../../plugins/runtime/native-subagent-context.js").NativeSubagentCommandFactory
        | undefined,
    ) => Promise<T>,
  ) => Promise<T>;
  /** Settles attribution before tool effects; model preparation may run concurrently. */
  awaitSessionDiffBaseline?: () => Promise<void>;
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
  /** Live channel policy retained from ingress through awaited lifecycle mutations. */
  assertChannelAuthority?: () => void;
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
  /** Activity committed with this input before ACK; initialization reuses its timestamp. */
  recordedSessionActivity?: { sessionId: string; sessionKey: string; at: number };
  /** Retained predecessor evidence; reply admission must verify its session lineage and store. */
  expectedActiveReplyOperation?: ReplyOperation;
  /** First dispatch only: admission created this exact pinned session before reply initialization. */
  newlyCreatedSessionId?: string;
  onDeliberateSilentTerminalReply?: () => void;
  /** Source-specific final delivery, e.g. a committed answer in the current WebChat history. */
  resolveReplyDelivery?: ReplyDeliveryObserver;
  /** Distinguishes committed source-tool custody from ordinary transcript presentation. */
  resolveReplyDeliveryFacts?: ReplyDeliveryFactsObserver;
  /** Retire the run's bundle MCP runtime at settlement. Set by one-shot isolated runs whose session ID is never reused. */
  cleanupBundleMcpOnRunEnd?: boolean;
  /** Defers child completion until the waiting status or explicit silent handoff settles. */
  onPendingContinuation?: (settlement?: PendingContinuationSettlement) => void;
  bindSessionCreation?: SessionEventExecution["bindSessionCreation"];
  /** Follow the admitted turn's own first-store registration in its retained request facts. */
  onDatabaseRegistration?: AgentDatabaseRequestExecutionSource["onRegistryChange"];
  onSessionCreated?: (created: SessionEntryCreationCommit) => void;

  /** Receives the LLM's own final response text — pre-delivery-normalization, sentinels included. */
  onRawLlmResponse?: (response: string) => void;
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
  /** Delivers queued replies only through their originating Gateway admission. */
  onQueuedFollowupReplyBatch?: QueuedFollowupReplyDelivery;
  /** Overrides persisted queue mode for this reply only. */
  queueModeOverride?: QueueMode;
  /** Dispatch-owned operation used to defer hooks until durable run admission. */
  replyOperation?: ReplyOperation;
  /** Observe the admitted owner without transferring the runner's settlement custody. */
  onReplyOperationAdmitted?: (operation: ReplyOperation) => void;
  /** Return true only when the caller accepts settlement custody for this exact operation. */
  onReplyOperationOwned?: (operation: ReplyOperation) => boolean | void;
  skillOverrides?: SessionToolOverrides["skills"];
  skillLibraryAuthoring?: import("../../skills/library/authoring.js").SkillLibraryAuthoringCapability;
};

export type InternalGetReplyOptions = GetReplyOptions &
  PluginCommandReplyOptions &
  InternalReplySessionOptions &
  ReplyOptionsWithOperationRunState &
  ReplySourceBinding;

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
