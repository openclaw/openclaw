/**
 * Conversation store for MS Teams proactive messaging.
 *
 * Stores ConversationReference objects keyed by conversation ID so we can
 * send proactive messages later (after the webhook turn has completed).
 */

import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";

/** Minimal ConversationReference shape for proactive messaging */
export type StoredConversationReference = {
  /** Activity ID from the last message */
  activityId?: string;
  /** User who sent the message */
  user?: { id?: string; name?: string; aadObjectId?: string };
  /** Bot that received the message */
  bot?: { id?: string; name?: string };
  /** Conversation details */
  conversation?: { id?: string; conversationType?: string; tenantId?: string };
  /** Channel ID (usually "msteams") */
  channelId?: string;
  /** Service URL for sending messages back */
  serviceUrl?: string;
  /** Locale */
  locale?: string;
};

type ConversationStoreData = {
  version: 1;
  conversations: Record<string, StoredConversationReference>;
};

const STORE_FILENAME = "msteams-conversations.json";
const MAX_CONVERSATIONS = 1000;

function resolveStorePath(): string {
  const stateDir = resolveStateDir(process.env);
  return path.join(stateDir, STORE_FILENAME);
}

async function readStore(): Promise<ConversationStoreData> {
  try {
    const raw = await fs.promises.readFile(resolveStorePath(), "utf-8");
    const data = JSON.parse(raw) as ConversationStoreData;
    if (data.version !== 1) {
      return { version: 1, conversations: {} };
    }
    return data;
  } catch {
    return { version: 1, conversations: {} };
  }
}

async function writeStore(data: ConversationStoreData): Promise<void> {
  const filePath = resolveStorePath();
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Save a conversation reference for later proactive messaging.
 */
export async function saveConversationReference(
  conversationId: string,
  reference: StoredConversationReference,
): Promise<void> {
  const store = await readStore();

  // Prune if over limit (keep most recent)
  const keys = Object.keys(store.conversations);
  if (keys.length >= MAX_CONVERSATIONS) {
    const toRemove = keys.slice(0, keys.length - MAX_CONVERSATIONS + 1);
    for (const key of toRemove) {
      delete store.conversations[key];
    }
  }

  store.conversations[conversationId] = reference;
  await writeStore(store);
}

/**
 * Get a stored conversation reference.
 */
export async function getConversationReference(
  conversationId: string,
): Promise<StoredConversationReference | null> {
  const store = await readStore();
  return store.conversations[conversationId] ?? null;
}

/**
 * List all stored conversation references.
 */
export async function listConversationReferences(): Promise<
  Array<{ conversationId: string; reference: StoredConversationReference }>
> {
  const store = await readStore();
  return Object.entries(store.conversations).map(
    ([conversationId, reference]) => ({
      conversationId,
      reference,
    }),
  );
}

/**
 * Remove a conversation reference.
 */
export async function removeConversationReference(
  conversationId: string,
): Promise<boolean> {
  const store = await readStore();
  if (!(conversationId in store.conversations)) return false;
  delete store.conversations[conversationId];
  await writeStore(store);
  return true;
}
