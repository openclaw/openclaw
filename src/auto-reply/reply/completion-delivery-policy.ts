// Resolves whether completed replies should send visibly or stay tool-only.
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { deriveSessionChatTypeFromKey } from "../../sessions/session-chat-type-shared.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.read.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { SourceReplyDeliveryMode } from "../source-reply-delivery-mode.types.js";
import { resolveSourceReplyDeliveryMode } from "./source-reply-delivery-mode.js";

type CompletionChatType = ChatType | "unknown";

type DurableCompletionDeliveryMode = "automatic" | "host_owned";

type CompletionDeliverySessionEntry = Pick<SessionEntry, "chatType" | "delivery">;

function resolveCompletionChatType(params: {
  requesterSessionKey?: string | null;
  targetRequesterSessionKey?: string | null;
  requesterEntry?: CompletionDeliverySessionEntry;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
}): CompletionChatType {
  const explicit = normalizeChatType(
    params.requesterEntry?.chatType ?? sessionDeliveryOrigin(params.requesterEntry)?.chatType,
  );
  if (explicit) {
    return explicit;
  }

  for (const key of [params.targetRequesterSessionKey, params.requesterSessionKey]) {
    const derived = deriveSessionChatTypeFromKey(key);
    if (derived !== "unknown") {
      return derived;
    }
  }

  return inferCompletionChatTypeFromTarget(
    params.directOrigin?.to ?? params.requesterSessionOrigin?.to,
  );
}

export function completionRequiresMessageToolDelivery(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string | null;
  targetRequesterSessionKey?: string | null;
  requesterEntry?: CompletionDeliverySessionEntry;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
  messageToolAvailable?: boolean;
}): boolean {
  return (
    resolveSourceReplyDeliveryMode({
      cfg: params.cfg,
      ctx: {
        ChatType: resolveCompletionChatType(params),
      },
      messageToolAvailable: params.messageToolAvailable,
    }) === "message_tool_only"
  );
}

/** Resolve transport authority for a durable, fixed-route agent completion. */
export function resolveDurableCompletionDeliveryMode(
  sourceReplyDeliveryMode: SourceReplyDeliveryMode,
): DurableCompletionDeliveryMode {
  // Message-tool-only blocks ambient model replies. A durable completion is an
  // explicit system send: the host fixes route/payload and withholds the message tool.
  return sourceReplyDeliveryMode === "message_tool_only" ? "host_owned" : "automatic";
}

function inferCompletionChatTypeFromTarget(to: string | undefined): CompletionChatType {
  const normalized = to?.trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  if (normalized.startsWith("group:")) {
    return "group";
  }
  if (normalized.startsWith("channel:") || normalized.startsWith("thread:")) {
    return "channel";
  }
  if (
    normalized.startsWith("dm:") ||
    normalized.startsWith("direct:") ||
    normalized.startsWith("user:")
  ) {
    return "direct";
  }
  return "unknown";
}
