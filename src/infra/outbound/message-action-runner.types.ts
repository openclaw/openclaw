import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import type { DurableMessageSendIntent } from "../../channels/message/types.js";
import type { ConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import type {
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { InternalChannelThreadingToolContext } from "../../channels/threading-tool-context-internal.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayClientMode, GatewayClientName } from "../../utils/message-channel.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import type { DurableDeliveryCompletion } from "./delivery-completion.js";
import type { OutboundMirror } from "./mirror.js";
import type { OutboundSendDeps } from "./send-deps.js";

/** Gateway connection and identity options for a message action. */
export type MessageActionRunnerGateway = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  resolveAgentRuntimeIdentityToken?: (context?: {
    sourceReplyFinal?: boolean;
    sourceReplyToolCallId?: string;
  }) => Promise<string | undefined>;
  terminalSourceReplyReceiptOwner?: "caller";
  clientName: GatewayClientName;
  clientDisplayName?: string;
  mode: GatewayClientMode;
};

/** Complete input contract for dispatching one normalized message action. */
export type RunMessageActionParams = {
  cfg: OpenClawConfig;
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
  defaultAccountId?: string;
  requesterAccountId?: string | null;
  requesterSenderId?: string | null;
  requesterSenderName?: string | null;
  requesterSenderUsername?: string | null;
  requesterSenderE164?: string | null;
  senderIsOwner?: boolean;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  /** Host-issued authorization facts for the current turn. */
  messageActionAuthorization?: {
    requesterAccountId?: string;
    requesterSenderId?: string;
    toolContext?: InternalChannelThreadingToolContext;
  };
  sessionId?: string;
  toolContext?: ChannelThreadingToolContext;
  gateway?: MessageActionRunnerGateway;
  deps?: OutboundSendDeps;
  sessionKey?: string;
  agentId?: string;
  /** Caller owns durable outbound context and must avoid the generic delivery mirror. */
  suppressTranscriptMirror?: boolean;
  /** @internal Explicit durable transcript destination owned by the caller. */
  transcriptMirror?: OutboundMirror;
  /** @internal Channel-valid id reserved before a correlated conversation turn is sent. */
  preparedMessageId?: string;
  /** @internal The Gateway owns this call and may use its active gateway-mode adapter directly. */
  gatewayOwnedDelivery?: boolean;
  /** @internal Bypass provider-native action dispatch so core durable delivery owns the send. */
  forceCoreDelivery?: boolean;
  /** @internal Fail before platform I/O unless the core delivery queue persisted the intent. */
  requireQueuePersistence?: boolean;
  /** @internal Stable producer id for idempotent durable queue creation. */
  deliveryIntentId?: string;
  /** @internal Serializable owner state finalized by live send or recovery. */
  deliveryCompletion?: DurableDeliveryCompletion;
  /** @internal Runs after queue persistence and before platform I/O. */
  onDeliveryIntent?: (intent: DurableMessageSendIntent) => void;
  /** @internal Runs on identified platform evidence before queue acknowledgement. */
  onDeliveryResult?: (result: OutboundDeliveryResult) => Promise<void> | void;
  sandboxRoot?: string;
  dryRun?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  sourceReplyFinal?: boolean;
  sourceReplyToolCallId?: string;
  inboundEventKind?: InboundEventKind;
  inboundAudio?: boolean;
  abortSignal?: AbortSignal;
};
