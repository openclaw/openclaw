import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionWorkerPlacementContext } from "../../gateway/worker-environments/session-placement-lifecycle.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import type { CommandSessionMetadataChange } from "./command-session-metadata.js";
import type { InternalGetReplyFromConfig, InternalGetReplyOptions } from "./get-reply.types.js";
import type {
  ReplyDispatchKind,
  ReplyDispatchReceipt,
  ReplyDispatcher,
} from "./reply-dispatcher.types.js";

export type DispatchProcessedOutcome = "completed" | "skipped" | "error";

export type DispatchProcessedOptions = {
  reason?: string;
  error?: string;
  userPrompt?: string;
  finalResponse?: string;
};

export type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
  failedCounts?: Partial<Record<ReplyDispatchKind, number>>;
  settledReceipt?: ReplyDispatchReceipt;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  sendPolicyDenied?: boolean;
  observedReplyDelivery?: boolean;
  deferredToActiveRun?: "steer" | "followup";
  noVisibleReplyFallbackEligible?: boolean;
  noVisibleReplyFallbackDelivered?: boolean;
  deliberateSilentTerminalReply?: true;
  beforeAgentRunBlocked?: boolean;
  collaborativeSteeringRefused?: true;
  sessionMetadataChanges?: CommandSessionMetadataChange[];
};

export type InboundMessageAuditTerminalRecorder = {
  note: (outcome: DispatchProcessedOutcome, options?: DispatchProcessedOptions) => void;
  observeRunId: (runId: string) => void;
  finishSuccess: (result: DispatchFromConfigResult) => void;
  finishError: () => void;
};

export type DispatchFromConfigParams = {
  ctx: FinalizedMsgContext;
  /** Full runtime config captured by the channel; reply resolution refreshes it per turn. */
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<InternalGetReplyOptions, "onBlockReply" | "onPreparedBlockReply">;
  replyResolver?: InternalGetReplyFromConfig;
  onSessionMetadataChanges?: (changes: CommandSessionMetadataChange[]) => void;
  fastAbortResolver?: typeof tryFastAbortFromMessage;
  formatAbortReplyTextResolver?: typeof formatAbortReplyText;
  /** Optional patch applied to the current runtime config before reply resolution. */
  configOverride?: OpenClawConfig;
  /** Gateway-owned worker services for archive recovery outside a request scope. */
  sessionWorkerPlacementContext?: SessionWorkerPlacementContext;
  /** @deprecated Omit this option; published model runtime is always enabled in the Gateway. */
  usePublishedModelRuntime?: boolean;
};

export type DispatchReplyOperationCoordinatorParams = {
  allowActiveQueueResolution?: boolean;
  agentId: string;
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  dispatcher: ReplyDispatcher;
  dispatchOperationSessionKey?: string;
  initialDispatchReplyOperation?: ReplyOperation;
  messageAuditTerminal?: InboundMessageAuditTerminalRecorder;
  operationSessionStoreEntry: {
    entry?: SessionEntry;
    storePath?: string;
  };
  replyOptions?: DispatchFromConfigParams["replyOptions"];
  sessionWorkerPlacementContext?: SessionWorkerPlacementContext;
  resolveOperationExpectedSessionId: () => string | undefined;
  routeThreadId?: string | number;
};

export type DispatchReplyFromConfig = (
  params: DispatchFromConfigParams,
) => Promise<DispatchFromConfigResult>;
