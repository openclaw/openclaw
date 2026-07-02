// Resolves whether completed replies should send visibly or stay tool-only.
import type { ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  deriveSessionChatTypeFromKey,
  resolveSessionEntryChatType,
} from "../../sessions/session-chat-type-shared.js";
import { resolveLongTermMemoryTargetChatType } from "../../sessions/session-memory-policy.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { resolveSourceReplyDeliveryMode } from "./source-reply-delivery-mode.js";

type CompletionChatType = ChatType | "unknown";

type CompletionDeliverySessionEntry = {
  chatType?: string | null;
  longTermMemoryDefaultPolicy?: "include" | "explicit-only" | null;
  origin?: { chatType?: string | null } | null;
  route?: { target?: { chatType?: string | null } | null } | null;
};

export function resolveCompletionChatType(params: {
  requesterSessionKey?: string | null;
  targetRequesterSessionKey?: string | null;
  requesterEntry?: CompletionDeliverySessionEntry;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
}): CompletionChatType {
  const targetChatType = resolveLongTermMemoryTargetChatType({
    sessionKey: params.targetRequesterSessionKey ?? params.requesterSessionKey,
    storedChatType: resolveSessionEntryChatType(params.requesterEntry),
    longTermMemoryDefaultPolicy: params.requesterEntry?.longTermMemoryDefaultPolicy,
    preferStoredPolicy: true,
  });
  if (targetChatType) {
    return targetChatType;
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

export function shouldRouteCompletionThroughRequesterSession(params: {
  requesterEntry?: CompletionDeliverySessionEntry;
  requesterSessionKey?: string | null;
  targetRequesterSessionKey?: string | null;
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
