import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Static } from "typebox";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
  type GatewayClientInfo,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  formatValidationErrors,
  validateChatSendParams,
  type HumanMention,
} from "../../../packages/gateway-protocol/src/index.js";
import type {
  AutoSteerReceipt,
  ChatSendParamsSchema,
  QueueMode,
} from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { isBtwRequestText } from "../../auto-reply/reply/btw-command.js";
import {
  captureChatWorkContext,
  formatChatWorkContext,
  type AttachedChatWorkContext,
} from "../../chat/work-context.js";
import type { SessionGoalOperation } from "../../config/sessions/goals-operations.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import {
  isProgressCardRefreshInputProvenance,
  normalizeInputProvenance,
} from "../../sessions/input-provenance.js";
import {
  readProviderReviewAcknowledgment,
  type ProviderReviewAcknowledgment,
} from "../../sessions/provider-review.js";
import {
  isBrowserCopilotClient,
  isBrowserOperatorUiClient,
  isOperatorUiClient,
} from "../../utils/message-channel.js";
import { isChatStopCommandText } from "../chat-abort.js";
import type { ChatAttachment } from "../chat-attachments.js";
import { sanitizeChatSendMessageInput } from "../chat-input-sanitize.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import { normalizeChatHumanMentions } from "./chat-human-mentions.js";
import {
  hasGatewayAdminScope,
  normalizeExplicitChatSendOrigin,
  normalizeOptionalChatSystemReceipt,
  type ChatSendExplicitOrigin,
} from "./chat-origin-routing.js";
import { resolveControlUiReconnectResumeParams } from "./chat-server-timing.js";
import { fingerprintSessionGoalRequest } from "./session-goal-request.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

// TypeBox validates these string enums narrowly but infers them as string.
type ChatSendRequestParams = Omit<
  Static<typeof ChatSendParamsSchema>,
  "queueMode" | "systemInputProvenance"
> & {
  queueMode?: QueueMode;
  systemInputProvenance?: InputProvenance;
};

export type NormalizedChatSendRequest = {
  /** Host advice is captured before transcript admission, never accepted from the client. */
  autoSteer?: AutoSteerReceipt;
  resolvedQueueMode?: QueueMode;
  providerReviewAcknowledgment?: ProviderReviewAcknowledgment;
  goalOperation?: SessionGoalOperation & { action: "start" | "resume" };
  chatSendReceivedAtMs: number;
  clientInfo?: GatewayClientInfo;
  supportsTaskSuggestions: boolean;
  p: ChatSendRequestParams;
  explicitOrigin?: ChatSendExplicitOrigin;
  inboundMessage: string;
  systemInputProvenance?: InputProvenance;
  systemProvenanceReceipt?: string;
  suppressCommandInterpretation: boolean;
  toolBindings?: Readonly<Record<string, unknown>>;
  stopCommand: boolean;
  turnKind: "btw" | "main";
  normalizedAttachments: ChatAttachment[];
  rawMessage: string;
  /** Submitted annotation identity is immutable even when profile aliases later merge. */
  requestIdentity: string;
  mentions?: HumanMention[];
  workContext?: AttachedChatWorkContext;
  reconnectResumeRequested: boolean;
};

type NormalizeChatSendRequestResult =
  | { ok: true; value: NormalizedChatSendRequest }
  | { ok: false; error: string; reason?: string };

/** Validate and normalize the wire request before session or lifecycle work begins. */
export function normalizeChatSendRequest(params: {
  params: Record<string, unknown>;
  client: GatewayRequestHandlerOptions["client"];
  trustedSystemInput?: boolean;
  goalResume?: SessionGoalOperation & { action: "resume" };
  providerReviewAcknowledgment?: ProviderReviewAcknowledgment;
}): NormalizeChatSendRequestResult {
  const chatSendReceivedAtMs = performance.now();
  const client = params.client;
  const clientInfo = client?.connect?.client;
  const supportsTaskSuggestions =
    isOperatorUiClient(clientInfo) &&
    params.client?.connect?.scopes?.includes("operator.admin") === true &&
    hasGatewayClientCap(params.client?.connect?.caps, GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS);
  const controlUiReconnectResume = resolveControlUiReconnectResumeParams(params.params, clientInfo);
  if (!validateChatSendParams(controlUiReconnectResume.params)) {
    return {
      ok: false,
      error: `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
    };
  }

  const p = controlUiReconnectResume.params as ChatSendRequestParams;
  const providerReview = params.providerReviewAcknowledgment
    ? readProviderReviewAcknowledgment(params.providerReviewAcknowledgment)
    : undefined;
  if (
    providerReview &&
    (p.sessionId !== providerReview.target.sessionId ||
      p.idempotencyKey !== providerReview.nextRunId ||
      p.message !== providerReview.review.review?.continuation?.message ||
      p.attachments?.length ||
      p.intent ||
      p.queueMode ||
      p.toolBindings ||
      p.workContext ||
      p.systemInputProvenance ||
      p.systemProvenanceReceipt ||
      p.suppressCommandInterpretation !== undefined ||
      p.thinking !== undefined ||
      p.fastMode !== undefined ||
      p.timeoutMs !== undefined)
  ) {
    return { ok: false, error: "Provider continuation no longer matches the reviewed input." };
  }
  const suppressCommandInterpretation = p.suppressCommandInterpretation === true;
  const explicitOriginResult = normalizeExplicitChatSendOrigin({
    originatingChannel: p.originatingChannel,
    originatingTo: p.originatingTo,
    accountId: p.originatingAccountId,
    messageThreadId: p.originatingThreadId,
  });
  if (!explicitOriginResult.ok) {
    return explicitOriginResult;
  }
  if (
    (p.systemInputProvenance ||
      p.systemProvenanceReceipt ||
      suppressCommandInterpretation ||
      explicitOriginResult.value) &&
    !params.trustedSystemInput &&
    !hasGatewayAdminScope(params.client)
  ) {
    return {
      ok: false,
      error:
        p.systemInputProvenance || p.systemProvenanceReceipt || suppressCommandInterpretation
          ? "system provenance fields require admin scope"
          : "originating route fields require admin scope",
    };
  }

  const sanitizedMessageResult = sanitizeChatSendMessageInput(p.message);
  if (!sanitizedMessageResult.ok) {
    return sanitizedMessageResult;
  }
  if (
    p.intent &&
    (!p.message.trim() ||
      p.message.length > 16_000 ||
      p.idempotencyKey.length > 128 ||
      p.queueMode !== undefined ||
      p.systemInputProvenance !== undefined ||
      p.systemProvenanceReceipt !== undefined ||
      p.suppressCommandInterpretation !== undefined ||
      sanitizedMessageResult.message !== p.message.normalize("NFC"))
  ) {
    return {
      ok: false,
      error:
        "Goal start requires a nonempty objective of at most 16000 characters, without queue or system-input options.",
    };
  }
  if (
    p.intent &&
    (explicitOriginResult.value !== undefined ||
      p.deliver === true ||
      p.toolBindings !== undefined ||
      p.thinking !== undefined ||
      p.fastMode !== undefined ||
      p.fastAutoOnSeconds !== undefined ||
      p.timeoutMs !== undefined ||
      controlUiReconnectResume.resumeRequested)
  ) {
    // Recovery reads the persisted input and session settings, not transient run overrides.
    return {
      ok: false,
      error:
        "Goal start uses the session settings and local delivery; per-request runtime or routing overrides are not supported.",
    };
  }
  const systemReceiptResult = normalizeOptionalChatSystemReceipt(p.systemProvenanceReceipt);
  if (!systemReceiptResult.ok) {
    return systemReceiptResult;
  }

  const goalOperation =
    params.goalResume ??
    (p.intent
      ? {
          action: "start" as const,
          operationId: p.idempotencyKey,
          issuedAtMs: p.intent.issuedAtMs,
          objective: p.message,
          requestFingerprint: fingerprintSessionGoalRequest([p, hasGatewayAdminScope(client)]),
        }
      : undefined);
  const commandInterpretationSuppressed =
    suppressCommandInterpretation || goalOperation !== undefined || providerReview !== undefined;
  // This text comes from the current provider review, not a browser-supplied command.
  const inboundMessage = p.intent || providerReview ? p.message : sanitizedMessageResult.message;
  const systemInputProvenance = params.goalResume
    ? { kind: "internal_system" as const, sourceTool: "session_goal_resume" }
    : normalizeInputProvenance(p.systemInputProvenance);
  if (!params.trustedSystemInput && isProgressCardRefreshInputProvenance(systemInputProvenance)) {
    return { ok: false, error: "Progress refresh input is reserved for progressCard.refresh." };
  }
  const systemProvenanceReceipt = systemReceiptResult.receipt;
  const stopCommand = !commandInterpretationSuppressed && isChatStopCommandText(inboundMessage);
  if (p.toolBindings) {
    if (
      !client ||
      !isBrowserCopilotClient(clientInfo) ||
      client.pairedClientId !== clientInfo?.id
    ) {
      return { ok: false, error: "run tool bindings require a paired browser copilot" };
    }
    if (!hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS)) {
      return { ok: false, error: "run tool bindings require client capability" };
    }
  }
  if (
    isBrowserCopilotClient(clientInfo) &&
    !stopCommand &&
    (!p.toolBindings || !Object.hasOwn(p.toolBindings, "browser"))
  ) {
    return { ok: false, error: "browser copilot runs require an explicit browser tool binding" };
  }
  // The browser plugin owns the binding schema and validates it while tools are
  // constructed, before model execution. Gateway owns only paired-client admission.
  const turnKind =
    !commandInterpretationSuppressed && isBtwRequestText(inboundMessage) ? "btw" : "main";
  const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(p.attachments);
  const rawMessage = goalOperation || providerReview ? inboundMessage : inboundMessage.trim();
  if (!rawMessage && normalizedAttachments.length === 0) {
    return { ok: false, error: "message or attachment required" };
  }
  const mentions = normalizeChatHumanMentions(
    p.message,
    p.mentions,
    sanitizedMessageResult.message,
  );
  if (!mentions.ok) {
    return mentions;
  }
  if (
    mentions.value &&
    (!isBrowserOperatorUiClient(clientInfo) ||
      !client?.authenticatedUserProfile ||
      client.internal?.syntheticClient ||
      client.internal?.senderAttribution ||
      goalOperation ||
      systemInputProvenance ||
      systemProvenanceReceipt ||
      explicitOriginResult.value ||
      suppressCommandInterpretation ||
      stopCommand ||
      turnKind !== "main" ||
      rawMessage.startsWith("/") ||
      rawMessage.startsWith("!"))
  ) {
    return {
      ok: false,
      error:
        "Human mentions require a signed-in Control UI chat. Remove the selected mentions to use this mode.",
    };
  }
  if (
    p.workContext &&
    (goalOperation ||
      stopCommand ||
      turnKind !== "main" ||
      rawMessage.startsWith("/") ||
      rawMessage.startsWith("!"))
  ) {
    return { ok: false, error: "Working context is only supported for ordinary chat messages." };
  }
  const workContext = p.workContext
    ? { snapshot: captureChatWorkContext(p.workContext), text: rawMessage }
    : undefined;
  if (workContext && !workContext.snapshot.page) {
    return { ok: false, error: "Working context requires a nonempty page." };
  }
  const modelMessage = workContext
    ? [rawMessage, formatChatWorkContext(workContext.snapshot)].filter(Boolean).join("\n\n")
    : rawMessage;
  const requestIdentity = createHash("sha256")
    .update(
      JSON.stringify([
        p.message,
        p.mentions?.map(({ profileId, start, end }) => [profileId, start, end]) ?? [],
        ...(workContext ? [workContext.snapshot] : []),
        ...(providerReview ? [providerReview.review.id, providerReview.target.sessionId] : []),
      ]),
    )
    .digest("hex");

  return {
    ok: true,
    value: {
      chatSendReceivedAtMs,
      clientInfo,
      supportsTaskSuggestions,
      p,
      ...(params.providerReviewAcknowledgment
        ? { providerReviewAcknowledgment: params.providerReviewAcknowledgment }
        : {}),
      ...(goalOperation ? { goalOperation } : {}),
      explicitOrigin: explicitOriginResult.value,
      inboundMessage: workContext ? modelMessage : inboundMessage,
      ...(workContext ? { workContext } : {}),
      systemInputProvenance,
      systemProvenanceReceipt,
      suppressCommandInterpretation: commandInterpretationSuppressed,
      toolBindings: p.toolBindings,
      stopCommand,
      turnKind,
      normalizedAttachments,
      rawMessage: modelMessage,
      requestIdentity,
      ...(mentions.value ? { mentions: mentions.value } : {}),
      reconnectResumeRequested: controlUiReconnectResume.resumeRequested,
    },
  };
}
