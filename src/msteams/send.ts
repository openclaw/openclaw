import type { ClawdbotConfig } from "../config/types.js";
import type { getChildLogger as getChildLoggerFn } from "../logging.js";
import type {
  MSTeamsConversationStore,
  StoredConversationReference,
} from "./conversation-store.js";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
} from "./errors.js";
import {
  buildConversationReference,
  type MSTeamsAdapter,
  sendMSTeamsMessages,
} from "./messenger.js";
import { buildMSTeamsPollCard } from "./polls.js";
import { resolveMSTeamsCredentials } from "./token.js";

let _log: ReturnType<typeof getChildLoggerFn> | undefined;
const getLog = async (): Promise<ReturnType<typeof getChildLoggerFn>> => {
  if (_log) return _log;
  const { getChildLogger } = await import("../logging.js");
  _log = getChildLogger({ name: "msteams:send" });
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

export type SendMSTeamsPollParams = {
  /** Full config (for credentials) */
  cfg: ClawdbotConfig;
  /** Conversation ID or user ID to send to */
  to: string;
  /** Poll question */
  question: string;
  /** Poll options */
  options: string[];
  /** Max selections (defaults to 1) */
  maxSelections?: number;
};

export type SendMSTeamsPollResult = {
  pollId: string;
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
async function findConversationReference(recipient: {
  type: "conversation" | "user";
  id: string;
  store: MSTeamsConversationStore;
}): Promise<{
  conversationId: string;
  ref: StoredConversationReference;
} | null> {
  if (recipient.type === "conversation") {
    const ref = await recipient.store.get(recipient.id);
    if (ref) return { conversationId: recipient.id, ref };
    return null;
  }

  const found = await recipient.store.findByUserId(recipient.id);
  if (!found) return null;
  return { conversationId: found.conversationId, ref: found.reference };
}

function extractMessageId(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  if (!("id" in response)) return null;
  const { id } = response as { id?: unknown };
  if (typeof id !== "string" || !id) return null;
  return id;
}

async function sendMSTeamsActivity(params: {
  adapter: MSTeamsAdapter;
  appId: string;
  conversationRef: StoredConversationReference;
  activity: Record<string, unknown>;
}): Promise<string> {
  const baseRef = buildConversationReference(params.conversationRef);
  const proactiveRef = {
    ...baseRef,
    activityId: undefined,
  };
  let messageId = "unknown";
  await params.adapter.continueConversation(
    params.appId,
    proactiveRef,
    async (ctx) => {
      const response = await ctx.sendActivity(params.activity);
      messageId = extractMessageId(response) ?? "unknown";
    },
  );
  return messageId;
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

  const store = createMSTeamsConversationStoreFs();

  // Parse recipient and find conversation reference
  const recipient = parseRecipient(to);
  const found = await findConversationReference({ ...recipient, store });

  if (!found) {
    throw new Error(
      `No conversation reference found for ${recipient.type}:${recipient.id}. ` +
        `The bot must receive a message from this conversation before it can send proactively.`,
    );
  }

  const { conversationId, ref } = found;

  const log = await getLog();

  log.debug("sending proactive message", {
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

  const message = mediaUrl
    ? text
      ? `${text}\n\n${mediaUrl}`
      : mediaUrl
    : text;
  let messageIds: string[];
  try {
    messageIds = await sendMSTeamsMessages({
      replyStyle: "top-level",
      adapter: adapter as unknown as MSTeamsAdapter,
      appId: creds.appId,
      conversationRef: ref,
      messages: [message],
      // Enable default retry/backoff for throttling/transient failures.
      retry: {},
      onRetry: (event) => {
        log.debug("retrying send", { conversationId, ...event });
      },
    });
  } catch (err) {
    const classification = classifyMSTeamsSendError(err);
    const hint = formatMSTeamsSendErrorHint(classification);
    const status = classification.statusCode
      ? ` (HTTP ${classification.statusCode})`
      : "";
    throw new Error(
      `msteams send failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`,
    );
  }
  const messageId = messageIds[0] ?? "unknown";

  log.info("sent proactive message", { conversationId, messageId });

  return {
    messageId,
    conversationId,
  };
}

/**
 * Send a poll (Adaptive Card) to a Teams conversation or user.
 */
export async function sendPollMSTeams(
  params: SendMSTeamsPollParams,
): Promise<SendMSTeamsPollResult> {
  const { cfg, to, question, options, maxSelections } = params;
  const msteamsCfg = cfg.msteams;

  if (!msteamsCfg?.enabled) {
    throw new Error("msteams provider is not enabled");
  }

  const creds = resolveMSTeamsCredentials(msteamsCfg);
  if (!creds) {
    throw new Error("msteams credentials not configured");
  }

  const store = createMSTeamsConversationStoreFs();
  const recipient = parseRecipient(to);
  const found = await findConversationReference({ ...recipient, store });

  if (!found) {
    throw new Error(
      `No conversation reference found for ${recipient.type}:${recipient.id}. ` +
        `The bot must receive a message from this conversation before it can send proactively.`,
    );
  }

  const { conversationId, ref } = found;
  const log = await getLog();

  const pollCard = buildMSTeamsPollCard({
    question,
    options,
    maxSelections,
  });

  log.debug("sending poll", {
    conversationId,
    pollId: pollCard.pollId,
    optionCount: pollCard.options.length,
  });

  const agentsHosting = await import("@microsoft/agents-hosting");
  const { CloudAdapter, getAuthConfigWithDefaults } = agentsHosting;

  const authConfig = getAuthConfigWithDefaults({
    clientId: creds.appId,
    clientSecret: creds.appPassword,
    tenantId: creds.tenantId,
  });

  const adapter = new CloudAdapter(authConfig);
  const activity = {
    type: "message",
    text: pollCard.fallbackText,
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: pollCard.card,
      },
    ],
  };

  let messageId: string;
  try {
    messageId = await sendMSTeamsActivity({
      adapter: adapter as unknown as MSTeamsAdapter,
      appId: creds.appId,
      conversationRef: ref,
      activity,
    });
  } catch (err) {
    const classification = classifyMSTeamsSendError(err);
    const hint = formatMSTeamsSendErrorHint(classification);
    const status = classification.statusCode
      ? ` (HTTP ${classification.statusCode})`
      : "";
    throw new Error(
      `msteams poll send failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`,
    );
  }

  log.info("sent poll", { conversationId, pollId: pollCard.pollId, messageId });

  return {
    pollId: pollCard.pollId,
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
  const store = createMSTeamsConversationStoreFs();
  const all = await store.list();
  return all.map(({ conversationId, reference }) => ({
    conversationId,
    userName: reference.user?.name,
    conversationType: reference.conversation?.conversationType,
  }));
}
