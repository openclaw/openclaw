import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { collectTextContentBlocks } from "../../agents/content-blocks.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import {
  findConversationTurnDeliveryByReplyTarget,
  markConversationDeliveryReplied,
  markConversationDeliverySent,
} from "../../config/sessions/conversation-delivery-store.js";
import { conversationIdentityFromMsgContext } from "../../config/sessions/conversation-identity.js";
import {
  resolveConversationRegistryScope,
  runConversationDatabaseWrite,
} from "../../config/sessions/conversation-registry.js";
import {
  appendTranscriptEventSync,
  loadSessionEntryReadOnly,
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
import { buildChannelUserTurnSender } from "../../sessions/user-turn-transcript.metadata.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { normalizeMessageTimestampMs } from "./message-timestamp.js";

const CONVERSATION_TURN_REPLY_CUSTOM_TYPE = "openclaw.conversation-turn-reply";

function readPersistedReplyText(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | undefined)?.content;
  return normalizeOptionalString(
    typeof content === "string" ? content : collectTextContentBlocks(content).join("\n"),
  );
}

async function capturePendingConversationTurnReplyUnsafe(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedRuntimeMsgContext;
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
  const replyText = normalizeOptionalString(params.ctx.agentText);
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
  const replyTarget = {
    messageId,
    ...(replyToId ? { replyToId } : {}),
    ...(threadId ? { threadId } : {}),
  };
  const agentId =
    normalizeOptionalString(params.ctx.AgentId) ?? resolveAgentIdFromSessionKey(sessionKey);
  const scope = resolveConversationRegistryScope({ agentId, config: params.cfg });
  const sessionEntry = loadSessionEntryReadOnly({
    ...scope,
    sessionKey,
    readConsistency: "latest",
  });
  if (!sessionEntry) {
    return false;
  }
  const timestamp = normalizeMessageTimestampMs(params.ctx.Timestamp);
  const parentConversationRef = threadId
    ? (conversation.parentConversationRef ??
      buildConversationRef({
        channel: conversation.channel,
        accountId: conversation.accountId,
        kind: conversation.kind,
        peerId: conversation.peerId,
      }))
    : undefined;
  const input: UserTurnInput = {
    // This is the model-facing reply returned by the tool, so its durable copy
    // must pass through the same write hook and redaction policy as transcripts.
    text: replyText,
    timestamp,
    idempotencyKey: `conversation-inbound:${conversation.conversationRef}:${messageId}`,
    ...(params.ctx.InputProvenance ? { provenance: params.ctx.InputProvenance } : {}),
    transport: {
      channel: conversation.channel,
      conversationRef: conversation.conversationRef,
      ...replyTarget,
    },
    sender:
      conversation.kind === "group" || conversation.kind === "channel"
        ? buildChannelUserTurnSender(params.ctx)
        : undefined,
  };
  const claim = await claimPendingConversationTurnReply({
    agentId,
    conversationRef: conversation.conversationRef,
    ...(parentConversationRef ? { parentConversationRef } : {}),
    sessionId: sessionEntry.sessionId,
    messageId,
    replyToId,
    threadId,
    text: replyText,
    timestamp,
  });
  if (!claim) {
    if (!replyToId) {
      return false;
    }
    const operation =
      (await findConversationTurnDeliveryByReplyTarget(scope, {
        conversationRef: conversation.conversationRef,
        replyToId,
      })) ??
      (parentConversationRef && parentConversationRef !== conversation.conversationRef
        ? await findConversationTurnDeliveryByReplyTarget(scope, {
            conversationRef: parentConversationRef,
            replyToId,
          })
        : undefined);
    if (operation?.status === "replied" && operation.reply?.messageId === messageId) {
      return true;
    }
    if (operation && operation.status !== "replied") {
      // Ordinary inbound dispatch owns this reply when no process-local waiter remains.
      await markConversationDeliverySent(scope, operation.operationId, replyToId);
    }
    return false;
  }
  let replyCommitted = false;
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
    const persistedMessage = redactTranscriptMessage(prepared, params.cfg);
    const persistedReplyText = readPersistedReplyText(persistedMessage);
    if (!persistedReplyText) {
      throw new Error("captured conversation turn reply has no persistable text");
    }
    // Commit the replayable reply before its optional transcript audit artifact.
    await markConversationDeliveryReplied(
      scope,
      {
        operationId: claim.turnId,
        session: {
          sessionKey,
          sessionId: claim.sessionId,
          lifecycleRevision: sessionEntry.lifecycleRevision,
        },
        reply: {
          ...replyTarget,
          text: persistedReplyText,
          timestamp: timestamp ?? Date.now(),
        },
      },
      claim.assertCurrent,
    );
    replyCommitted = true;
    return await runConversationDatabaseWrite(scope, (writeScope) => {
      claim.assertCurrent();
      const current = loadSessionEntryReadOnly({
        ...writeScope,
        sessionKey,
        readConsistency: "latest",
      });
      if (
        current?.sessionId !== claim.sessionId ||
        current.lifecycleRevision !== sessionEntry.lifecycleRevision
      ) {
        throw new Error(`session changed before captured reply persistence: ${sessionKey}`);
      }
      const artifactId = `conversation-turn-reply-${claim.turnId}`;
      // The tool result owns model context. A side artifact keeps an audit trail
      // without inserting a user row between an active tool call and its result.
      let persisted = false;
      try {
        const appendResult = appendTranscriptEventSync(
          { ...writeScope, sessionId: sessionEntry.sessionId, sessionKey },
          {
            type: "custom",
            id: artifactId,
            customType: CONVERSATION_TURN_REPLY_CUSTOM_TYPE,
            appendMode: "side",
            timestamp: timestamp ?? Date.now(),
            data: {
              turnId: claim.turnId,
              conversationRef: conversation.conversationRef,
              ...replyTarget,
              message: persistedMessage,
            },
          },
        );
        persisted = appendResult.ok && appendResult.value;
        if (!appendResult.ok) {
          logVerbose(
            `captured conversation turn reply audit persistence failed: ${appendResult.error.code}`,
          );
        }
      } catch (error) {
        logVerbose(`captured conversation turn reply audit persistence failed: ${String(error)}`);
      }
      if (!persisted) {
        logVerbose("captured conversation turn reply audit artifact was not persisted");
      }
      claim.complete(persisted ? { transcriptArtifactId: artifactId } : undefined);
      return true;
    });
  } catch (error) {
    claim.release();
    logVerbose(`conversation turn reply capture failed: ${String(error)}`);
    // A committed reply remains consumed if the waiter expires during audit admission.
    return replyCommitted;
  }
}

/** Consumes a correlated channel reply before it can start a second local agent turn. */
export async function capturePendingConversationTurnReply(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedRuntimeMsgContext;
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
