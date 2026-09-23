import type { ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import type { createTtsDirectiveTextStreamCleaner } from "../../tts/directives.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { BlockReplySource } from "./block-reply-source.types.js";
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
  queuedUntrackedVisibleTextDeliveries: number;
  settledUntrackedVisibleText: boolean;
  routedCounts: Record<ReplyDispatchKind, number>;
  suppressionReason?: NormalizeReplySkipReason;
  toolMessageByCallId: Map<string, ToolMessageHandle>;
};

export type AcpDispatchDeliveryParams = {
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
