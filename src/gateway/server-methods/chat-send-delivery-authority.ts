import {
  getReplyPayloadMetadata,
  isReplyPayloadSessionWriterDeliveryAuthorized,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";
import { loadSessionEntry } from "../session-utils.js";
import { captureWebchatReplyMediaScope } from "./chat-reply-media.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestContext } from "./types.js";

export type ChatSendReplyFinalizationParams = {
  requesterContext?: Parameters<typeof captureWebchatReplyMediaScope>[0]["requesterContext"];
  abortSignal?: AbortSignal;
  accountId: string | undefined;
  context: GatewayRequestContext;
  terminalEntry: Pick<ChatAbortControllerEntry, "terminalOutcomeObserved"> | undefined;
  emitFirstAssistantServerTiming: () => void;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "sessionKey" | "sessionLoadOptions"
  >;
};

export function createChatSendReplyFinalizationAuthority(
  params: ChatSendReplyFinalizationParams & { isCurrent?: () => boolean },
  payloads: readonly ReplyPayload[],
  onUnauthorized?: () => void,
) {
  const { cfg, sessionKey, agentId, sessionLoadOptions } = params.session;
  const deliveryAuthorized = () =>
    (!params.isCurrent || params.isCurrent()) &&
    payloads.every((payload) => {
      const authority = getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority;
      if (!authority) {
        return true;
      }
      const current = loadSessionEntry(authority.sessionKey, {
        ...sessionLoadOptions,
        ...(authority.agentId || agentId ? { agentId: authority.agentId ?? agentId } : {}),
      }).entry;
      return isReplyPayloadSessionWriterDeliveryAuthorized(payload, current);
    });
  return {
    deliveryAuthorized,
    authorizeDelivery: (stage: string) => {
      if (deliveryAuthorized()) {
        return true;
      }
      params.context.logGateway.warn(
        `webchat settled final reply skipped: session writer changed before ${stage}`,
      );
      onUnauthorized?.();
      return false;
    },
    captureMediaScope: () =>
      captureWebchatReplyMediaScope({
        cfg,
        sessionKey,
        agentId,
        sessionLoadOptions,
        requesterContext: params.requesterContext,
        accountId: params.accountId,
        assertCurrent: () => {
          if (!deliveryAuthorized()) {
            throw new Error("Chat media delivery is no longer authorized.");
          }
        },
      }),
  };
}
