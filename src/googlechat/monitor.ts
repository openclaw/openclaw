import { type Message, PubSub } from "@google-cloud/pubsub";
import type { ClawdbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatEvent } from "./types.js";

export type GoogleChatMonitorOptions = {
  account: ResolvedGoogleChatAccount;
  config: ClawdbotConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
};

export type NormalizedGoogleChatMessage = {
  provider: "googlechat";
  accountId: string;
  messageId: string;
  timestamp: number;
  sender: {
    id: string;
    name: string;
    email?: string;
  };
  chat: {
    id: string;
    name: string;
    type: "dm" | "group";
  };
  thread?: {
    id: string;
  };
  content: {
    text: string;
  };
  raw: GoogleChatEvent;
};

function normalizeMessage(
  event: GoogleChatEvent,
  accountId: string,
): NormalizedGoogleChatMessage | null {
  if (event.type !== "MESSAGE" || !event.message) {
    return null;
  }

  const msg = event.message;

  // Skip messages from bots
  if (msg.sender.type === "BOT") {
    return null;
  }

  const spaceId = msg.space.name.replace("spaces/", "");
  const isDM = msg.space.type === "DM";

  return {
    provider: "googlechat",
    accountId,
    messageId: msg.name,
    timestamp: new Date(msg.createTime).getTime(),
    sender: {
      id: msg.sender.name.replace("users/", ""),
      name: msg.sender.displayName,
      email: msg.sender.email,
    },
    chat: {
      id: spaceId,
      name: msg.space.displayName || spaceId,
      type: isDM ? "dm" : "group",
    },
    thread: msg.thread
      ? {
          id: msg.thread.name,
        }
      : undefined,
    content: {
      text: msg.argumentText || msg.text || "",
    },
    raw: event,
  };
}

function checkMessagePolicy(
  message: NormalizedGoogleChatMessage,
  account: ResolvedGoogleChatAccount,
): boolean {
  const policy =
    message.chat.type === "dm"
      ? (account.config.dmPolicy ?? "pairing")
      : (account.config.spacePolicy ?? "disabled");

  switch (policy) {
    case "disabled":
      return false;
    case "open":
      return true;
    case "allowlist": {
      if (message.chat.type === "dm") {
        const allowFrom = account.config.allowFrom ?? [];
        return allowFrom.includes(message.sender.email ?? "");
      }
      const allowSpaces = account.config.allowSpaces ?? [];
      return allowSpaces.includes(message.chat.id);
    }
    case "pairing":
      // For pairing mode, we'd need to check the pairing store
      // For now, treat as allowlist-based
      return false;
    default:
      return false;
  }
}

export async function monitorGoogleChatProvider(
  options: GoogleChatMonitorOptions,
): Promise<() => void> {
  const { account, abortSignal } = options;

  if (!account.projectId || !account.subscriptionName) {
    throw new Error(
      `Google Chat account ${account.accountId} missing projectId or subscriptionName`,
    );
  }

  const pubsub = new PubSub({
    projectId: account.projectId,
    keyFilename: account.credentialsPath,
  });

  const subscription = pubsub.subscription(account.subscriptionName);

  const messageHandler = async (message: Message) => {
    try {
      const eventData = JSON.parse(message.data.toString()) as GoogleChatEvent;

      const normalized = normalizeMessage(eventData, account.accountId);

      if (normalized) {
        const allowed = checkMessagePolicy(normalized, account);
        if (allowed) {
          // Route to agent - this will be wired up by the gateway
          // For now, we just acknowledge the message
          console.log(
            `[googlechat:${account.accountId}] Received message from ${normalized.sender.name}`,
          );
        }
      }

      message.ack();
    } catch (error) {
      console.error(
        `[googlechat:${account.accountId}] Error processing message:`,
        error,
      );
      message.nack();
    }
  };

  const errorHandler = (error: Error) => {
    console.error(
      `[googlechat:${account.accountId}] Subscription error:`,
      error,
    );
  };

  subscription.on("message", messageHandler);
  subscription.on("error", errorHandler);

  // Handle abort signal
  const cleanup = () => {
    subscription.removeListener("message", messageHandler);
    subscription.removeListener("error", errorHandler);
    console.log(`[googlechat:${account.accountId}] Monitor stopped`);
  };

  if (abortSignal.aborted) {
    cleanup();
  } else {
    abortSignal.addEventListener("abort", cleanup, { once: true });
  }

  console.log(
    `[googlechat:${account.accountId}] Listening on subscription: ${account.subscriptionName}`,
  );

  return cleanup;
}
