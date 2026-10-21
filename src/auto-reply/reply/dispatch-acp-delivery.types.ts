import type { ChatType } from "../../channels/chat-type.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import type { ExtractedFileImage } from "../../media-understanding/extracted-file-images.js";
import type { PluginHookReplyDispatchContext } from "../../plugins/hook-types.js";
import type { createTtsDirectiveTextStreamCleaner } from "../../tts/directives.js";
import type { PreparedTtsPreferences } from "../../tts/tts-preferences.js";
import type { GetReplyOptions, SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { FinalizedMsgContext, FinalizedRuntimeMsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { BlockReplySource } from "./block-reply-source.types.js";
import type { InboundMessageAuditTerminalRecorder } from "./dispatch-from-config.types.js";
import type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

export type AcpDispatchDeliveryMeta = {
  toolCallId?: string;
  allowEdit?: boolean;
  skipTts?: boolean;
  /** Transport-only finals retain their runtime source instead of adding final text. */
  transcriptSource?: { kind: "blocks" } | { kind: "final"; text: string };
};

type ToolMessageHandle = {
  channel: string;
  accountId?: string;
  to: string;
  threadId?: string | number;
  messageId: string;
};

export type AcpBlockText = {
  payload: ReplyPayload;
  deliver: (kind: "block" | "final", skipTts?: boolean) => Promise<boolean>;
  transcriptText?: string;
  source?: BlockReplySource;
  needsFinalDelivery: boolean;
  // A terminal-only surface can confirm a block yet still need final delivery.
  delivered?: "block" | "final";
};

export type AcpDispatchDeliveryState = {
  startedReplyLifecycle: boolean;
  blockTexts: AcpBlockText[];
  accumulatedBlockTtsText: string;
  accumulatedFinalText: string;
  accumulatedDeliveredFinalText: string;
  pendingTranscriptOutcomes: Promise<void>[];
  cleanBlockTtsDirectiveText?: ReturnType<typeof createTtsDirectiveTextStreamCleaner>;
  deliveredFinalReply: boolean;
  pendingAnswerDelivery: boolean;
  pendingFinalTtsMedia: boolean;
  deliveredAnswerFinalToUser: boolean;
  deliveredFinalTtsMedia: boolean;
  deliveredVisibleText: boolean;
  failedVisibleTextDelivery: boolean;
  untrackedVisibleText: "none" | "pending" | "settled";
  routedCounts: Record<ReplyDispatchKind, number>;
  suppressionReason?: NormalizeReplySkipReason;
  toolMessageByCallId: Map<string, ToolMessageHandle>;
};

export type AcpDispatchDeliveryParams = {
  preparedTtsPreferences: PreparedTtsPreferences;
  cfg: OpenClawConfig;
  agentId?: string;
  ctx: FinalizedMsgContext;
  dispatcher: ReplyDispatcher;
  inboundAudio: boolean;
  sessionKey?: string;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  suppressUserDelivery?: boolean;
  suppressBlockUserDelivery?: boolean;
  suppressReplyLifecycle?: boolean;
  shouldRouteToOriginating: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string | number;
  originatingChatType?: ChatType;
  onReplyStart?: () => Promise<void> | void;
  abortSignal?: AbortSignal;
  runId?: string;
};

export type AcpDispatchAttemptResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};

export type AcpDispatchAttemptParams = Omit<
  AcpDispatchDeliveryParams,
  "agentId" | "ctx" | "suppressBlockUserDelivery" | "preparedTtsPreferences"
> & {
  preparedTtsPreferences?: PreparedTtsPreferences;
  ctx: FinalizedRuntimeMsgContext;
  toolsAllow?: string[];
  images?: Array<{ data: string; mimeType: string }>;
  extractedFileImages?: ExtractedFileImage[];
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  shouldSendToolSummaries: () => Promise<boolean>;
  shouldSendFullToolDetails: () => Promise<boolean>;
  bypassForCommand: boolean;
  onAgentRunStart?: GetReplyOptions["onAgentRunStart"];
  onPreparedAgentRunStart?: GetReplyOptions["onPreparedAgentRunStart"];
  turnAdoption?: PluginHookReplyDispatchContext["turnAdoption"];
  userTurnTranscriptRecorder?: GetReplyOptions["userTurnTranscriptRecorder"];
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  recordProcessed: InboundMessageAuditTerminalRecorder["note"];
  markIdle: (reason: string) => void;
};
