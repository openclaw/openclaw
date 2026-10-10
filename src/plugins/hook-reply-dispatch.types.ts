import type {
  GetReplyOptions,
  SourceReplyDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
import type {
  ReplyDispatchKind,
  ReplyDispatcher,
} from "../auto-reply/reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { ChatType } from "../channels/chat-type.js";
import type { PrepareAssistantTranscriptMessage } from "../config/sessions/transcript-assistant-delivery.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TtsAutoMode } from "../config/types.tts.js";

export type PluginHookReplyDispatchKind = "agent" | "acp";

export type PluginHookReplyDispatchEvent = {
  ctx: FinalizedMsgContext;
  runId?: string;
  sessionKey?: string;
  toolsAllow?: string[];
  images?: Array<{ data: string; mimeType: string }>;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  suppressUserDelivery?: boolean;
  suppressReplyLifecycle?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  shouldRouteToOriginating: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string | number;
  originatingChatType?: ChatType;
  /** @deprecated Await shouldSendToolSummariesAsync; retained until the next Plugin SDK major. */
  shouldSendToolSummaries: boolean;
  /** @deprecated Await shouldSendFullToolDetailsAsync; retained until the next Plugin SDK major. */
  shouldSendFullToolDetails: boolean;
  /** Fresh worker-backed visibility; supplied by current hosts. */
  shouldSendToolSummariesAsync?: () => Promise<boolean>;
  /** Fresh worker-backed detail visibility; supplied by current hosts. */
  shouldSendFullToolDetailsAsync?: () => Promise<boolean>;
  sendPolicy: "allow" | "deny";
  isTailDispatch?: boolean;
};

export type PluginHookReplyDispatchContext = {
  /** Host-resolved dispatch path; omitted when the caller cannot establish it. */
  dispatchKind?: PluginHookReplyDispatchKind;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  abortSignal?: AbortSignal;
  onReplyStart?: () => Promise<void> | void;
  onAgentRunStart?: GetReplyOptions["onAgentRunStart"];
  /** Await durable ingress adoption immediately before runtime prompt submission. */
  onTurnAdopted?: () => void | Promise<void>;
  userTurnTranscriptRecorder?: GetReplyOptions["userTurnTranscriptRecorder"];
  /** Host-owned display facts applied before the assistant transcript is published. */
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  recordProcessed: (
    outcome: "completed" | "skipped" | "error",
    opts?: {
      reason?: string;
      error?: string;
    },
  ) => void;
  markIdle: (reason: string) => void;
};

export type PluginHookReplyDispatchResult = {
  handled: boolean;
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};
