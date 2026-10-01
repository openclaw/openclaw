import type { SessionForkReplySelection } from "../../config/sessions/session-transcript-fork-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import { loadNativeForkSourceTarget } from "./commands-fork-source-target.js";

export async function readNativeForkReplySelection(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  replyToId: string;
  conversation: ConversationRef;
  replyConversationRef?: string;
  assertCurrent: () => void;
}): Promise<SessionForkReplySelection> {
  const current = await loadNativeForkSourceTarget({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    assertCurrent: params.assertCurrent,
  });
  if (!current.entry?.sessionId || current.entry.repositoryWorkspaceId) {
    return { status: "missing" };
  }
  const target = {
    agentId: current.target.agentId,
    sessionId: current.entry.sessionId,
    sessionKey: current.canonicalKey,
    storePath: current.storePath,
  };
  const { isIncognitoSessionKey } = await import("../../shared/incognito-session-key.js");
  if (current.entry.incognito === true || isIncognitoSessionKey(current.canonicalKey)) {
    // Incognito transcripts live in the Gateway process, not the transcript worker.
    const { readSessionForkReplySelection } =
      await import("../../config/sessions/session-transcript-fork-reply.js");
    return readSessionForkReplySelection({
      target,
      replyToId: params.replyToId,
      conversation: params.conversation,
      replyConversationRef: params.replyConversationRef,
    });
  }
  const { readSessionForkReplySelectionInWorker } =
    await import("../../config/sessions/session-transcript-read-worker-runtime.js");
  return await readSessionForkReplySelectionInWorker({
    target,
    replyToId: params.replyToId,
    conversation: params.conversation,
    replyConversationRef: params.replyConversationRef,
  });
}
