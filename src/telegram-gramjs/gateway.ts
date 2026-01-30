/**
 * Gateway adapter for GramJS.
 *
 * Manages:
 * - Client lifecycle (connect/disconnect)
 * - Message polling (via event handlers)
 * - Message queue for openclaw
 * - Outbound delivery
 */

import type {
  ChannelGatewayAdapter,
  ChannelGatewayContext,
} from "../channels/plugins/types.adapters.js";
import type { ResolvedGramJSAccount } from "./types.js";
import { GramJSClient } from "./client.js";
import { convertToMsgContext } from "./handlers.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("telegram-gramjs:gateway");

type ActiveConnection = {
  client: GramJSClient;
  messageQueue: Array<{ context: any; timestamp: number }>;
  lastPollTime: number;
};

const activeConnections = new Map<string, ActiveConnection>();

/**
 * Start a GramJS client for an account.
 */
async function startAccount(
  ctx: ChannelGatewayContext<ResolvedGramJSAccount>,
): Promise<ActiveConnection> {
  const { account, accountId, abortSignal } = ctx;
  const config = account.config;

  log.info(`Starting GramJS account: ${accountId}`);

  // Validate configuration
  if (!config.apiId || !config.apiHash) {
    throw new Error(
      "Missing API credentials (apiId, apiHash). Get them from https://my.telegram.org/apps",
    );
  }

  if (!config.sessionString) {
    throw new Error("No session configured. Run 'openclaw setup telegram-gramjs' to authenticate.");
  }

  // Create client
  const client = new GramJSClient({
    apiId: config.apiId,
    apiHash: config.apiHash,
    sessionString: config.sessionString,
    connectionRetries: 5,
    timeout: 30,
  });

  // Connect with existing session
  await client.connect();

  // Set up message queue
  const connection: ActiveConnection = {
    client,
    messageQueue: [],
    lastPollTime: Date.now(),
  };

  // Register message handler
  client.onMessage(async (gramjsContext) => {
    try {
      // Convert to openclaw format
      const msgContext = await convertToMsgContext(gramjsContext, account, accountId);

      if (msgContext) {
        // Apply security checks
        if (!isMessageAllowed(msgContext, account)) {
          log.verbose(`Message blocked by security policy: ${msgContext.From}`);
          return;
        }

        // Add to queue
        connection.messageQueue.push({
          context: msgContext,
          timestamp: Date.now(),
        });

        log.verbose(
          `Queued message from ${msgContext.From} (queue size: ${connection.messageQueue.length})`,
        );
      }
    } catch (err) {
      log.error("Error handling message:", err);
    }
  });

  // Store connection
  activeConnections.set(accountId, connection);

  // Handle abort signal
  if (abortSignal) {
    abortSignal.addEventListener("abort", async () => {
      log.info(`Stopping GramJS account: ${accountId} (aborted)`);
      await stopAccountInternal(accountId);
    });
  }

  log.success(`GramJS account started: ${accountId}`);

  // Update status
  ctx.setStatus({
    ...ctx.getStatus(),
    running: true,
    lastStartAt: new Date().toISOString(),
    lastError: null,
  });

  return connection;
}

/**
 * Stop a GramJS client.
 */
async function stopAccount(ctx: ChannelGatewayContext<ResolvedGramJSAccount>): Promise<void> {
  await stopAccountInternal(ctx.accountId);

  ctx.setStatus({
    ...ctx.getStatus(),
    running: false,
    lastStopAt: new Date().toISOString(),
  });
}

async function stopAccountInternal(accountId: string): Promise<void> {
  const connection = activeConnections.get(accountId);
  if (!connection) {
    log.verbose(`No active connection for account: ${accountId}`);
    return;
  }

  try {
    log.info(`Disconnecting GramJS client: ${accountId}`);
    await connection.client.disconnect();
    activeConnections.delete(accountId);
    log.success(`GramJS account stopped: ${accountId}`);
  } catch (err) {
    log.error(`Error stopping account ${accountId}:`, err);
    throw err;
  }
}

/**
 * Check if a message is allowed based on security policies.
 */
function isMessageAllowed(msgContext: any, account: ResolvedGramJSAccount): boolean {
  const config = account.config;

  // For DMs, check allowFrom
  if (msgContext.ChatType === "direct") {
    const allowFrom = config.allowFrom || [];
    if (allowFrom.length > 0) {
      const senderId = msgContext.SenderId || msgContext.From;
      const senderUsername = msgContext.SenderUsername;

      // Check if sender is in allowlist (by ID or username)
      const isAllowed = allowFrom.some((entry) => {
        const normalized = String(entry).replace(/^@/, "");
        return (
          senderId === normalized || senderId === String(entry) || senderUsername === normalized
        );
      });

      if (!isAllowed) {
        log.verbose(`DM from ${senderId} not in allowFrom list`);
        return false;
      }
    }
  }

  // For groups, check group allowlist
  if (msgContext.ChatType === "group") {
    const groupPolicy = config.groupPolicy || "open";

    if (groupPolicy === "allowlist") {
      const groupAllowFrom = config.groupAllowFrom || [];
      const groupId = String(msgContext.GroupId);

      if (groupAllowFrom.length > 0) {
        const isAllowed = groupAllowFrom.some((entry) => {
          return String(entry) === groupId;
        });

        if (!isAllowed) {
          log.verbose(`Group ${groupId} not in groupAllowFrom list`);
          return false;
        }
      }
    }

    // Check group-specific allowlist
    const groups = config.groups || {};
    const groupConfig = groups[String(msgContext.GroupId)];

    if (groupConfig?.allowFrom) {
      const senderId = msgContext.SenderId || msgContext.From;
      const isAllowed = groupConfig.allowFrom.some((entry) => {
        return String(entry) === senderId;
      });

      if (!isAllowed) {
        log.verbose(`Sender ${senderId} not in group-specific allowFrom`);
        return false;
      }
    }
  }

  return true;
}

/**
 * Poll for new messages (drain the queue).
 */
async function pollMessages(accountId: string): Promise<any[]> {
  const connection = activeConnections.get(accountId);
  if (!connection) {
    return [];
  }

  // Drain the queue
  const messages = connection.messageQueue.splice(0);
  connection.lastPollTime = Date.now();

  if (messages.length > 0) {
    log.verbose(`Polled ${messages.length} messages for account ${accountId}`);
  }

  return messages.map((m) => m.context);
}

/**
 * Send an outbound message via GramJS.
 */
async function sendMessage(
  accountId: string,
  params: {
    to: string;
    text: string;
    replyToId?: string;
    threadId?: string;
  },
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const connection = activeConnections.get(accountId);

  if (!connection) {
    return {
      success: false,
      error: "Client not connected",
    };
  }

  try {
    const { to, text, replyToId } = params;

    log.verbose(`Sending message to ${to}: ${text.slice(0, 50)}...`);

    // Convert target to appropriate format
    // Support: @username, chat_id (number), or -100... (supergroup)
    let chatId: string | number = to;
    if (to.startsWith("@")) {
      chatId = to; // GramJS handles @username
    } else if (/^-?\d+$/.test(to)) {
      chatId = Number(to);
    }

    const result = await connection.client.sendMessage({
      chatId,
      text,
      replyToId: replyToId ? Number(replyToId) : undefined,
      parseMode: undefined, // Use default (no markdown)
      linkPreview: true,
    });

    log.success(`Message sent successfully: ${result.id}`);

    return {
      success: true,
      messageId: String(result.id),
    };
  } catch (err: any) {
    log.error("Error sending message:", err);
    return {
      success: false,
      error: err.message || String(err),
    };
  }
}

/**
 * Gateway adapter export.
 */
export const gatewayAdapter: ChannelGatewayAdapter<ResolvedGramJSAccount> = {
  startAccount,
  stopAccount,
};

/**
 * Export polling and sending functions for use by channel plugin.
 */
export { pollMessages, sendMessage };
