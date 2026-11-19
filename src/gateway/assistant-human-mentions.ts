import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { err, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  MAX_HUMAN_MENTIONS,
  errorShape,
  type ErrorShape,
  type HumanMention,
} from "../../packages/gateway-protocol/src/index.js";
import type { TranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { sanitizeChatSendMessageInput } from "./chat-input-sanitize.js";
import type { MentionInbox } from "./mention-inbox.types.js";
import { normalizeChatHumanMentions } from "./server-methods/chat-human-mentions.js";
import {
  injectGatewayAssistantMessage,
  type GatewayAssistantInjectionContext,
} from "./server-methods/chat-inject.js";

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

function invalid(message: string): Result<never, ErrorShape> {
  return err(errorShape(ErrorCodes.INVALID_REQUEST, message));
}

/**
 * Insert a Gateway-authored assistant message that mentions people.
 *
 * Trusted Gateway callers only: no RPC method exposes this. The transcript row
 * carries the same `__openclaw.humanMentions` spans as a human message, and the
 * Mention Inbox applies the human mention policy (recipient can read, no
 * self-mention, no incognito) when it records involvement and Inbox items.
 */
export async function injectAssistantMessageWithHumanMentions(
  context: GatewayAssistantInjectionContext & { mentionInbox?: MentionInbox },
  params: {
    sessionKey: string;
    agentId?: string;
    /** Exact displayed Markdown; mention spans are UTF-16 offsets into it. */
    text: string;
    mentions: readonly HumanMention[];
    /** Human profile the Inbox names as sender, for example the session owner. */
    onBehalfOfProfileId: string;
    /** Stable caller key; a retry replays the same transcript row and Inbox source. */
    idempotencyKey: string;
  },
  sessionMutationCommitGuard?: () => void,
): Promise<Result<{ messageId: string; replayed?: true }, ErrorShape>> {
  const { mentionInbox } = context;
  if (!mentionInbox) {
    return err(errorShape(ErrorCodes.UNAVAILABLE, "Mentions are unavailable."));
  }
  const key = params.idempotencyKey.trim();
  if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return invalid("A mention message needs a stable idempotency key.");
  }
  if (isIncognitoSessionKey(params.sessionKey)) {
    return invalid("Incognito sessions cannot contain mentions.");
  }
  const sanitized = sanitizeChatSendMessageInput(params.text);
  if (!sanitized.ok || !params.text || sanitized.message.trim() !== params.text) {
    return invalid("Mention message text must be trimmed, normalized text.");
  }
  if (!params.mentions.length || params.mentions.length > MAX_HUMAN_MENTIONS) {
    return invalid(`A mention message needs 1 to ${MAX_HUMAN_MENTIONS} mentions.`);
  }
  const normalized = normalizeChatHumanMentions(params.text, params.mentions, params.text);
  const mentions = normalized.ok ? normalized.value : undefined;
  if (!mentions) {
    return invalid("Mention spans must select @labels in the message text.");
  }
  if (mentions.some((mention) => mention.profileId === params.onBehalfOfProfileId)) {
    return invalid("A mention message cannot mention its sender.");
  }
  const sourceId = `assistant-mention:${key}`;
  let committed: { anchor: TranscriptEntryAnchor; timestamp: number } | undefined;
  const injected = await injectGatewayAssistantMessage(
    context,
    {
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      message: params.text,
      idempotencyKey: sourceId,
      humanMentions: mentions,
      // Mention offsets bind the exact bytes; Gateway-authored text carries no model directives.
      literal: true,
      // Replays reach this callback too, so a retry finishes an interrupted delivery;
      // the Inbox source key and involvement source keep it from alerting twice.
      onMessageCommitted: ({ anchor, message }) => {
        const timestamp = asOptionalRecord(message)?.timestamp;
        if (anchor && typeof timestamp === "number") {
          committed = { anchor, timestamp };
        }
      },
    },
    sessionMutationCommitGuard,
  );
  // Deliver after the transcript write admission is released; delivery writes session metadata.
  if (injected.ok && committed) {
    const { anchor, timestamp } = committed;
    await mentionInbox.recordCommittedInputAsync({
      sourceId,
      committedSource: { generation: anchor.generation, sequence: anchor.rawSeq, timestamp },
      agentId: anchor.agentId,
      sessionKey: anchor.sessionKey,
      sessionId: anchor.sessionId,
      messageId: anchor.entryId,
      senderProfileId: params.onBehalfOfProfileId,
      recipientProfileIds: mentions.map((mention) => mention.profileId),
      excerpt: params.text,
    });
  }
  return injected;
}
