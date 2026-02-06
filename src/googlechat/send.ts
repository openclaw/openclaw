import { type chat_v1, google } from "googleapis";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

const chatClients: Map<string, chat_v1.Chat> = new Map();

async function getChatClient(
  account: ResolvedGoogleChatAccount,
): Promise<chat_v1.Chat> {
  const cacheKey = `${account.accountId}:${account.credentialsPath ?? "default"}`;
  const cached = chatClients.get(cacheKey);
  if (cached) return cached;

  const auth = new google.auth.GoogleAuth({
    keyFile: account.credentialsPath,
    scopes: ["https://www.googleapis.com/auth/chat.bot"],
  });

  const client = google.chat({
    version: "v1",
    auth,
  });

  chatClients.set(cacheKey, client);
  return client;
}

export type SendGoogleChatResult = {
  messageId: string;
  spaceName: string;
};

export async function sendGoogleChatText(
  to: string,
  text: string,
  options: {
    account: ResolvedGoogleChatAccount;
    threadKey?: string;
    replyToId?: string;
  },
): Promise<SendGoogleChatResult> {
  const client = await getChatClient(options.account);

  const spaceName = to.startsWith("spaces/") ? to : `spaces/${to}`;

  const prefix = options.account.config.messagePrefix;
  const formattedText = prefix ? `${prefix} ${text}` : text;

  const requestBody: chat_v1.Schema$Message = {
    text: formattedText,
  };

  if (options.threadKey) {
    requestBody.thread = { name: options.threadKey };
  }

  const response = await client.spaces.messages.create({
    parent: spaceName,
    requestBody,
  });

  return {
    messageId: response.data.name ?? "",
    spaceName,
  };
}

export async function sendGoogleChatCard(
  to: string,
  card: chat_v1.Schema$CardWithId,
  options: {
    account: ResolvedGoogleChatAccount;
    threadKey?: string;
    text?: string;
  },
): Promise<SendGoogleChatResult> {
  const client = await getChatClient(options.account);

  const spaceName = to.startsWith("spaces/") ? to : `spaces/${to}`;

  const requestBody: chat_v1.Schema$Message = {
    cardsV2: [card],
  };

  if (options.text) {
    requestBody.text = options.text;
  }

  if (options.threadKey) {
    requestBody.thread = { name: options.threadKey };
  }

  const response = await client.spaces.messages.create({
    parent: spaceName,
    requestBody,
  });

  return {
    messageId: response.data.name ?? "",
    spaceName,
  };
}

export async function sendGoogleChatMedia(
  to: string,
  mediaUrl: string,
  options: {
    account: ResolvedGoogleChatAccount;
    caption?: string;
    threadKey?: string;
  },
): Promise<SendGoogleChatResult> {
  // Google Chat doesn't support direct media upload via API for bots
  // Send as a card with image
  const card: chat_v1.Schema$CardWithId = {
    cardId: `media-${Date.now()}`,
    card: {
      sections: [
        {
          widgets: [
            {
              image: {
                imageUrl: mediaUrl,
                altText: options.caption ?? "Image",
              },
            },
          ],
        },
      ],
    },
  };

  if (options.caption && card.card?.sections?.[0]?.widgets) {
    card.card.sections[0].widgets.unshift({
      textParagraph: { text: options.caption },
    });
  }

  return sendGoogleChatCard(to, card, {
    account: options.account,
    threadKey: options.threadKey,
  });
}

/**
 * Chunk text for Google Chat (4096 char limit).
 */
export function chunkGoogleChatText(text: string, maxLength = 4000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find last newline or space within limit
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
