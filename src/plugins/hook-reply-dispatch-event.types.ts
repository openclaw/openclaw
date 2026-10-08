import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { ChatType } from "../channels/chat-type.js";
import type { TtsAutoMode } from "../config/types.tts.js";

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
