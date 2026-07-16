import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import { conversationIdentityFromMsgContext } from "../../config/sessions/conversation-identity.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  appendTranscriptEventSync,
  appendTranscriptMessageSync,
  loadSessionEntry,
  publishTranscriptUpdate,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { buildConversationRef } from "../../routing/conversation-ref.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { claimPendingConversationTurnReply } from "../../sessions/conversation-turns.js";
import {
  buildPersistedUserTurnMessage,
  preparePersistedUserTurnMessageForTranscriptWrite,
  type UserTurnInput,
} from "../../sessions/user-turn-transcript.js";
import type { FinalizedMsgContext } from "../templating.js";

const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;
const CONVERSATION_TURN_REPLY_CUSTOM_TYPE = "openclaw.conversation-turn-reply";

function normalizeTimestamp(value: unknown): number | undefined {
  const timestamp = typeof value === "number" && Number.isFinite(value) ? value : undefined;
  if (timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  return asDateTimestampMs(
    timestamp < EPOCH_MILLISECONDS_THRESHOLD ? Math.trunc(timestamp * 1_000) : timestamp,
  );
}

async function capturePendingConversationTurnReplyUnsafe(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
}): Promise<boolean> {
  // Only channel owners can attest ingress admission. Raw/plugin-constructed
  // contexts without this proof must follow ordinary dispatch and its guards.
  if (params.ctx.InboundAccessAuthorized !== true) {
    return false;
  }
  const sessionKey = normalizeOptionalString(params.ctx.SessionKey);
  const messageId =
    normalizeOptionalString(params.ctx.MessageSidFull) ??
    normalizeOptionalString(params.ctx.MessageSid) ??
    normalizeOptionalString(params.ctx.MessageSidFirst) ??
    normalizeOptionalString(params.ctx.MessageSidLast);
  const replyText =
    normalizeOptionalString(params.ctx.BodyForAgent) ??
    normalizeOptionalString(params.ctx.RawBody) ??
    normalizeOptionalString(params.ctx.Body);
  if (!sessionKey || !messageId || !replyText) {
    return false;
  }
  const conversation = conversationIdentityFromMsgContext({ ctx: params.ctx });
  if (!conversation) {
    return false;
  }
  const replyToId =
    normalizeOptionalString(params.ctx.ReplyToIdFull) ??
    normalizeOptionalString(params.ctx.ReplyToId);
  const threadId =
    params.ctx.MessageThreadId == null
      ? undefined
      : normalizeOptionalString(String(params.ctx.MessageThreadId));
  const agentId =
    normalizeOptionalString(params.ctx.AgentId) ?? resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const sessionEntry = loadSessionEntry({
    agentId,
    sessionKey,
    storePath,
    readConsistency: "latest",
  });
  if (!sessionEntry) {
    return false;
  }
  const timestamp = normalizeTimestamp(params.ctx.Timestamp);
  const transcriptText = normalizeOptionalString(params.ctx.RawBody)
    ? params.ctx.RawBody
    : replyText;
  const input: UserTurnInput = {
    text: transcriptText,
    timestamp,
    idempotencyKey: `conversation-inbound:${conversation.conversationRef}:${messageId}`,
    ...(params.ctx.InputProvenance ? { provenance: params.ctx.InputProvenance } : {}),
    transport: {
      channel: conversation.channel,
      conversationRef: conversation.conversationRef,
      messageId,
      ...(replyToId ? { replyToId } : {}),
      ...(threadId ? { threadId } : {}),
    },
    sender:
      conversation.kind === "group" || conversation.kind === "channel"
        ? {
            id: normalizeOptionalString(params.ctx.SenderId),
            name: normalizeOptionalString(params.ctx.SenderName),
            username: normalizeOptionalString(params.ctx.SenderUsername),
          }
        : undefined,
  };
  const claim = await claimPendingConversationTurnReply({
    conversationRef: conversation.conversationRef,
    ...(threadId
      ? {
          parentConversationRef:
            conversation.parentConversationRef ??
            buildConversationRef({
              channel: conversation.channel,
              accountId: conversation.accountId,
              kind: conversation.kind,
              peerId: conversation.peerId,
            }),
        }
      : {}),
    sessionId: sessionEntry.sessionId,
    messageId,
    replyToId,
    threadId,
    text: replyText,
    timestamp,
  });
  if (!claim) {
    return false;
  }
  try {
    if (sessionEntry.sessionId !== claim.sessionId) {
      throw new Error(`session changed before captured reply persistence: ${sessionKey}`);
    }
    const prepared = preparePersistedUserTurnMessageForTranscriptWrite(
      buildPersistedUserTurnMessage(input),
      {
        agentId,
        sessionKey,
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      },
    );
    if (!prepared) {
      throw new Error("captured conversation turn reply was blocked before persistence");
    }
    if (claim.persistence === "tool-result") {
      const artifactId = `conversation-turn-reply-${claim.turnId}`;
      // A same-session user row would split the active tool call/result pair.
      // Keep a redacted side artifact durable while the tool result owns model context.
      const persisted = appendTranscriptEventSync(
        { agentId, sessionId: sessionEntry.sessionId, sessionKey, storePath },
        {
          type: "custom",
          id: artifactId,
          customType: CONVERSATION_TURN_REPLY_CUSTOM_TYPE,
          appendMode: "side",
          timestamp: timestamp ?? Date.now(),
          data: {
            turnId: claim.turnId,
            conversationRef: conversation.conversationRef,
            messageId,
            ...(replyToId ? { replyToId } : {}),
            ...(threadId ? { threadId } : {}),
            message: redactTranscriptMessage(prepared, params.cfg),
          },
        },
      );
      if (!persisted) {
        throw new Error("captured conversation turn reply artifact was not persisted");
      }
      claim.complete({ transcriptArtifactId: artifactId });
      return true;
    }
    const persisted = appendTranscriptMessageSync(
      { agentId, sessionId: sessionEntry.sessionId, sessionKey, storePath },
      {
        config: params.cfg,
        idempotencyLookup: "scan",
        message: prepared,
      },
    );
    if (!persisted) {
      throw new Error("captured conversation turn reply was not persisted");
    }
    void publishTranscriptUpdate(
      { agentId, sessionId: sessionEntry.sessionId, sessionKey, storePath },
      { message: persisted.message, messageId: persisted.messageId },
    );
    claim.complete({ transcriptMessageId: persisted.messageId });
    return true;
  } catch (error) {
    claim.release();
    logVerbose(`conversation turn reply capture failed: ${String(error)}`);
    return false;
  }
}

/** Consumes a correlated channel reply before it can start a second local agent turn. */
export async function capturePendingConversationTurnReply(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
}): Promise<boolean> {
  try {
    return await capturePendingConversationTurnReplyUnsafe(params);
  } catch (error) {
    // Correlation is an optional interception path. Storage/config failures must
    // fall through to ordinary inbound dispatch and its existing lifecycle cleanup.
    logVerbose(`conversation turn reply capture unavailable: ${String(error)}`);
    return false;
  }
}
