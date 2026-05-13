import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { resolveSourceReplyDeliveryMode } from "./source-reply-delivery-mode.js";

export type CompletionChatType = ChatType | "unknown";

export type CompletionDeliverySessionEntry = {
  chatType?: string | null;
};

export function resolveCompletionChatType(params: {
  requesterSessionKey?: string | null;
  targetRequesterSessionKey?: string | null;
  requesterEntry?: CompletionDeliverySessionEntry;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
}): CompletionChatType {
  const explicit = normalizeChatType(params.requesterEntry?.chatType ?? undefined);
  if (explicit) {
    return explicit;
  }

  const directOriginChatType = normalizeChatType(params.directOrigin?.chatType);
  if (directOriginChatType) {
    return directOriginChatType;
  }
  const requesterOriginChatType = normalizeChatType(params.requesterSessionOrigin?.chatType);
  if (requesterOriginChatType) {
    return requesterOriginChatType;
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

export function shouldRouteCompletionThroughRequesterSession(params: {
  requesterSessionKey?: string | null;
  targetRequesterSessionKey?: string | null;
  requesterEntry?: CompletionDeliverySessionEntry;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
}): boolean {
  const chatType = resolveCompletionChatType(params);
  return chatType === "group" || chatType === "channel";
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
