import {
  getReplyPayloadMetadata,
  isReplyPayloadSessionWriterDeliveryAuthorized,
  type ReplyPayload,
  type SessionWriterDeliveryAuthority,
} from "../../auto-reply/reply-payload.js";
import { prepareSessionWriterDeliveryAuthority } from "../../auto-reply/reply/session-writer-delivery-authority.js";
import type { RpcSourceRef } from "../../sessions/session-controller.rpc-sources.js";
import { captureChatAbortRegistrationGuard } from "../chat-abort-lifecycle-internal.js";
import { captureWebchatReplyMediaScope } from "./chat-reply-media.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestContext } from "./types.js";

export type ChatSendReplyFinalizationParams = {
  requesterContext?: Parameters<typeof captureWebchatReplyMediaScope>[0]["requesterContext"];
  abortSignal?: AbortSignal;
  accountId: string | undefined;
  context: GatewayRequestContext;
  terminalEntry: RpcSourceRef | undefined;
  emitFirstAssistantServerTiming: () => void;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "sessionKey" | "sessionLoadOptions"
  > & { storePath?: string };
};

export async function createChatSendReplyFinalizationAuthority(
  params: ChatSendReplyFinalizationParams & { isCurrent?: () => boolean },
  payloads: readonly ReplyPayload[],
  onUnauthorized?: () => void,
) {
  const { cfg, sessionKey, agentId, sessionLoadOptions } = params.session;
  const sourceIsCurrent = params.terminalEntry
    ? captureChatAbortRegistrationGuard([
        { runId: params.session.clientRunId, entry: params.terminalEntry },
      ])
    : () => true;
  const prepared = new Map<
    SessionWriterDeliveryAuthority,
    Awaited<ReturnType<typeof prepareSessionWriterDeliveryAuthority>>
  >();
  try {
    for (const payload of payloads) {
      const authority = getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority;
      if (authority && !prepared.has(authority)) {
        const ownerAgentId = authority.agentId ?? agentId;
        prepared.set(
          authority,
          await prepareSessionWriterDeliveryAuthority(
            { ...authority, agentId: ownerAgentId },
            ownerAgentId === agentId ? params.session.storePath : undefined,
          ),
        );
      }
    }
  } catch (error) {
    for (const current of prepared.values()) {
      current.release();
    }
    throw error;
  }
  const mediaScopes: Awaited<ReturnType<typeof captureWebchatReplyMediaScope>>[] = [];
  const deliveryAuthorized = () =>
    sourceIsCurrent() &&
    (!params.isCurrent || params.isCurrent()) &&
    payloads.every((payload) => {
      const authority = getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority;
      return isReplyPayloadSessionWriterDeliveryAuthorized(
        payload,
        authority ? prepared.get(authority)?.authority?.readCurrentSession?.() : undefined,
      );
    });
  const authorizeDelivery = (stage: string) => {
    if (deliveryAuthorized()) {
      return true;
    }
    params.context.logGateway.warn(
      `webchat settled final reply skipped: session writer changed before ${stage}`,
    );
    onUnauthorized?.();
    return false;
  };
  return {
    deliveryAuthorized,
    authorizeDelivery,
    release: () => {
      for (const scope of mediaScopes) {
        scope.release();
      }
      for (const current of prepared.values()) {
        current.release();
      }
    },
    captureMediaScope: async () => {
      try {
        const scope = await captureWebchatReplyMediaScope({
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
        });
        mediaScopes.push(scope);
        return scope;
      } catch (error) {
        if (!authorizeDelivery("media preparation")) {
          return undefined;
        }
        throw error;
      }
    },
  };
}
