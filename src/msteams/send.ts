import type { ClawdbotConfig } from "../config/types.js";
import type { getChildLogger as getChildLoggerFn } from "../logging.js";
import {
  getConversationReference,
  listConversationReferences,
  type StoredConversationReference,
} from "./conversation-store.js";
import { resolveMSTeamsCredentials } from "./token.js";

// Lazy logger to avoid initialization order issues in tests
let _log: ReturnType<typeof getChildLoggerFn> | undefined;
const getLog = (): ReturnType<typeof getChildLoggerFn> => {
  if (!_log) {
    // Dynamic import to defer initialization
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getChildLogger } = require("../logging.js") as {
      getChildLogger: typeof getChildLoggerFn;
    };
    _log = getChildLogger({ name: "msteams:send" });
  }
  return _log;
};

export type SendMSTeamsMessageParams = {
  /** Full config (for credentials) */
  cfg: ClawdbotConfig;
  /** Conversation ID or user ID to send to */
  to: string;
  /** Message text */
  text: string;
  /** Optional media URL */
  mediaUrl?: string;
};

export type SendMSTeamsMessageResult = {
  messageId: string;
  conversationId: string;
};

/**
 * Parse the --to argument into a conversation reference lookup key.
 * Supported formats:
 * - conversation:19:abc@thread.tacv2 → lookup by conversation ID
 * - user:aad-object-id → lookup by user AAD object ID
 * - 19:abc@thread.tacv2 → direct conversation ID
 */
function parseRecipient(to: string): {
  type: "conversation" | "user";
  id: string;
} {
  const trimmed = to.trim();
  if (trimmed.startsWith("conversation:")) {
    return { type: "conversation", id: trimmed.slice("conversation:".length) };
  }
  if (trimmed.startsWith("user:")) {
    return { type: "user", id: trimmed.slice("user:".length) };
  }
  // Assume it's a conversation ID if it looks like one
  if (trimmed.startsWith("19:") || trimmed.includes("@thread")) {
    return { type: "conversation", id: trimmed };
  }
  // Otherwise treat as user ID
  return { type: "user", id: trimmed };
}

/**
 * Find a stored conversation reference for the given recipient.
 */
async function findConversationReference(
  recipient: { type: "conversation" | "user"; id: string },
): Promise<{ conversationId: string; ref: StoredConversationReference } | null> {
  if (recipient.type === "conversation") {
    const ref = await getConversationReference(recipient.id);
    if (ref) return { conversationId: recipient.id, ref };
    return null;
  }

  // Search by user AAD object ID
  const all = await listConversationReferences();
  for (const { conversationId, reference } of all) {
    if (reference.user?.aadObjectId === recipient.id) {
      return { conversationId, ref: reference };
    }
    if (reference.user?.id === recipient.id) {
      return { conversationId, ref: reference };
    }
  }
  return null;
}

// Type matching @microsoft/agents-activity ConversationReference
type ConversationReferenceShape = {
  activityId?: string;
  user?: { id: string; name?: string };
  bot?: { id: string; name?: string };
  conversation: { id: string; conversationType?: string; tenantId?: string };
  channelId: string;
  serviceUrl?: string;
  locale?: string;
};

/**
 * Build a Bot Framework ConversationReference from our stored format.
 * Note: activityId is intentionally omitted so proactive messages post as
 * top-level messages rather than replies/threads.
 */
function buildConversationReference(
  ref: StoredConversationReference,
): ConversationReferenceShape {
  if (!ref.conversation?.id) {
    throw new Error("Invalid stored reference: missing conversation.id");
  }
  return {
    // activityId omitted to avoid creating reply threads
    user: ref.user?.id ? { id: ref.user.id, name: ref.user.name } : undefined,
    bot: ref.bot?.id ? { id: ref.bot.id, name: ref.bot.name } : undefined,
    conversation: {
      id: ref.conversation.id,
      conversationType: ref.conversation.conversationType,
      tenantId: ref.conversation.tenantId,
    },
    channelId: ref.channelId ?? "msteams",
    serviceUrl: ref.serviceUrl,
    locale: ref.locale,
  };
}

/**
 * Send a message to a Teams conversation or user.
 *
 * Uses the stored ConversationReference from previous interactions.
 * The bot must have received at least one message from the conversation
 * before proactive messaging works.
 */
export async function sendMessageMSTeams(
  params: SendMSTeamsMessageParams,
): Promise<SendMSTeamsMessageResult> {
  const { cfg, to, text, mediaUrl } = params;
  const msteamsCfg = cfg.msteams;

  if (!msteamsCfg?.enabled) {
    throw new Error("msteams provider is not enabled");
  }

  const creds = resolveMSTeamsCredentials(msteamsCfg);
  if (!creds) {
    throw new Error("msteams credentials not configured");
  }

  // Parse recipient and find conversation reference
  const recipient = parseRecipient(to);
  const found = await findConversationReference(recipient);

  if (!found) {
    throw new Error(
      `No conversation reference found for ${recipient.type}:${recipient.id}. ` +
        `The bot must receive a message from this conversation before it can send proactively.`,
    );
  }

  const { conversationId, ref } = found;
  const conversationRef = buildConversationReference(ref);

  getLog().debug("sending proactive message", {
    conversationId,
    textLength: text.length,
    hasMedia: Boolean(mediaUrl),
  });

  // Dynamic import to avoid loading SDK when not needed
  const agentsHosting = await import("@microsoft/agents-hosting");
  const { CloudAdapter, getAuthConfigWithDefaults } = agentsHosting;

  const authConfig = getAuthConfigWithDefaults({
    clientId: creds.appId,
    clientSecret: creds.appPassword,
    tenantId: creds.tenantId,
  });

  const adapter = new CloudAdapter(authConfig);

  let messageId = "unknown";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (adapter as any).continueConversation(
    creds.appId,
    conversationRef,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (context: any) => {
      // Build the activity
      const activity = {
        type: "message",
        text: mediaUrl ? (text ? `${text}\n\n${mediaUrl}` : mediaUrl) : text,
      };
      const response = await context.sendActivity(activity);
      if (response?.id) {
        messageId = response.id;
      }
    },
  );

  getLog().info("sent proactive message", { conversationId, messageId });

  return {
    messageId,
    conversationId,
  };
}

/**
 * List all known conversation references (for debugging/CLI).
 */
export async function listMSTeamsConversations(): Promise<
  Array<{
    conversationId: string;
    userName?: string;
    conversationType?: string;
  }>
> {
  const all = await listConversationReferences();
  return all.map(({ conversationId, reference }) => ({
    conversationId,
    userName: reference.user?.name,
    conversationType: reference.conversation?.conversationType,
  }));
}
