// Resolves whether completed replies should send visibly or stay tool-only.
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { deriveSessionChatTypeFromKey } from "../../sessions/session-chat-type-shared.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.read.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { resolveSourceReplyDeliveryMode } from "./source-reply-delivery-mode.js";

type CompletionChatType = ChatType | "unknown";
const COMPLETION_TARGET_CHAT_TYPES = new Map<string, CompletionChatType>([
  ["group:", "group"],
  ["channel:", "channel"],
  ["thread:", "channel"],
  ["dm:", "direct"],
  ["direct:", "direct"],
  ["user:", "direct"],
]);

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

  const target =
    (params.directOrigin?.to ?? params.requesterSessionOrigin?.to)?.trim().toLowerCase() ?? "";
  const prefix = target.slice(0, target.indexOf(":") + 1);
  return COMPLETION_TARGET_CHAT_TYPES.get(prefix) ?? "unknown";
}

export function completionRequiresMessageToolDelivery(
  params: Parameters<typeof resolveCompletionChatType>[0] & {
    cfg: OpenClawConfig;
    messageToolAvailable?: boolean;
  },
): boolean {
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
