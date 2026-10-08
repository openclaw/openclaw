import { buildConversationIdentity } from "../config/sessions/conversation-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ConversationRef } from "../infra/outbound/session-binding-service.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { loadPluginForkSourceTarget } from "./plugin-command-fork-source-target.js";

/** Telegram reports the topic-root service message as ReplyToId even without an explicit reply. */
export function resolvePluginForkReplyToId(params: {
  conversation: ConversationRef;
  replyToId?: string;
  messageThreadId?: string | number;
}): string | undefined {
  const replyToId = params.replyToId?.trim();
  if (!replyToId) {
    return undefined;
  }
  const threadId = params.messageThreadId;
  if (
    params.conversation.channel === "telegram" &&
    threadId !== undefined &&
    replyToId === String(threadId) &&
    params.conversation.conversationId.endsWith(`:topic:${threadId}`)
  ) {
    return undefined;
  }
  return replyToId;
}

/** Match the host's durable transport reference, not a transient adapter route object. */
export function resolvePluginForkReplyConversationRef(params: {
  conversation: ConversationRef;
  chatType?: "direct" | "group" | "channel";
  messageThreadId?: string | number;
}): string | undefined {
  if (!params.chatType) {
    return undefined;
  }
  return buildConversationIdentity({
    channel: params.conversation.channel,
    accountId: params.conversation.accountId,
    kind: params.chatType,
    peerId: params.conversation.conversationId,
    deliveryTarget: params.conversation.conversationId,
    threadId: params.messageThreadId,
  })?.conversationRef;
}

export async function readPluginForkReplySelection(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  replyToId: string;
  conversation: ConversationRef;
  replyConversationRef?: string;
  assertCurrent: () => void;
}): Promise<
  { status: "found"; entryId: string; text: string } | { status: "media" } | { status: "missing" }
> {
  const current = await loadPluginForkSourceTarget({
    config: params.config,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    assertCurrent: params.assertCurrent,
  });
  if (!current.entry?.sessionId || current.entry.repositoryWorkspaceId) {
    return { status: "missing" };
  }
  const selection = {
    target: {
      agentId: current.target.agentId,
      sessionId: current.entry.sessionId,
      sessionKey: current.canonicalKey,
      storePath: current.storePath,
    },
    replyToId: params.replyToId,
    conversation: params.conversation,
    replyConversationRef: params.replyConversationRef,
  };
  if (current.entry.incognito === true || isIncognitoSessionKey(current.canonicalKey)) {
    // Incognito transcripts belong to this process's :memory: owner; a worker
    // would open a different empty database and falsely report a missing reply.
    const { readSessionForkReplySelection } =
      await import("../config/sessions/session-transcript-fork-reply.js");
    return readSessionForkReplySelection(selection);
  }
  const { readSessionForkReplySelectionInWorker } =
    await import("../config/sessions/session-transcript-read-worker-runtime.js");
  return readSessionForkReplySelectionInWorker(selection);
}
