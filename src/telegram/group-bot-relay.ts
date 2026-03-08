import type { Message } from "@grammyjs/types";

const RELAY_MAX_TURNS = 3;
const RELAY_COOLDOWN_MS = 5_000;
const MESSAGE_OWNER_TTL_MS = 24 * 60 * 60 * 1000;
const RELAY_META_SYMBOL = Symbol.for("openclaw.telegram.groupRelayMeta");

export type TelegramRelayChainMeta = {
  chainId: string;
  turn: number;
  humanInitiated: boolean;
};

export type TelegramRelayIdentity = {
  botUserId?: number;
  botUsername?: string;
  botDisplayName?: string;
};

export type TelegramGroupRelayInbound = {
  chatId: number | string;
  messageId: number;
  messageThreadId?: number;
  text: string;
  sentAtMs: number;
  replyToMessageId?: number;
  replyTargetsRecipient: boolean;
  source: {
    accountId: string;
    botUserId?: number;
    botUsername?: string;
    botDisplayName?: string;
  };
  target: {
    accountId: string;
    botUserId?: number;
    botUsername?: string;
    botDisplayName?: string;
  };
  relayMeta: TelegramRelayChainMeta;
};

type TelegramRelayEndpoint = {
  accountId: string;
  resolveIdentity: () => Promise<TelegramRelayIdentity | null>;
  handleRelay: (payload: TelegramGroupRelayInbound) => Promise<void>;
};

type PublishTelegramGroupRelayParams = {
  sourceAccountId: string;
  chatId: number | string;
  messageId: number;
  text?: string;
  replyToMessageId?: number;
  messageThreadId?: number;
  isGroup: boolean;
  sentAtMs?: number;
  chain: TelegramRelayChainMeta;
};

type TrackTelegramRelayMessageParams = {
  chatId: number | string;
  messageId: number;
  accountId: string;
  recordedAtMs?: number;
};

type MessageOwnerEntry = {
  accountId: string;
  recordedAtMs: number;
};

const relayEndpoints = new Map<string, TelegramRelayEndpoint>();
const relayMessageOwners = new Map<string, Map<number, MessageOwnerEntry>>();
const relayCooldownByKey = new Map<string, number>();

function normalizeChatKey(chatId: number | string): string {
  return String(chatId);
}

function normalizeUsername(username?: string): string | null {
  const value = username?.trim().replace(/^@+/, "").toLowerCase();
  return value ? value : null;
}

function isFiniteMessageId(messageId: number): boolean {
  return Number.isFinite(messageId) && messageId > 0;
}

function cleanupMessageOwners(map: Map<number, MessageOwnerEntry>, nowMs: number): void {
  for (const [messageId, owner] of map) {
    if (!isFiniteMessageId(messageId) || nowMs - owner.recordedAtMs > MESSAGE_OWNER_TTL_MS) {
      map.delete(messageId);
    }
  }
}

function cleanupCooldownEntries(nowMs: number): void {
  for (const [key, lastRelayMs] of relayCooldownByKey) {
    if (nowMs - lastRelayMs > RELAY_COOLDOWN_MS * 10) {
      relayCooldownByKey.delete(key);
    }
  }
}

function isTelegramMentionWordChar(char: string | undefined): boolean {
  if (!char) {
    return false;
  }
  return /[a-z0-9_]/i.test(char);
}

function textMentionsBot(text: string, username: string): boolean {
  if (!text) {
    return false;
  }
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) {
    return false;
  }
  const haystack = text.toLowerCase();
  const mention = `@${normalizedUsername}`;
  let startIndex = 0;
  while (startIndex < haystack.length) {
    const idx = haystack.indexOf(mention, startIndex);
    if (idx === -1) {
      return false;
    }
    const prev = idx > 0 ? haystack[idx - 1] : undefined;
    const next = haystack[idx + mention.length];
    if (!isTelegramMentionWordChar(prev) && !isTelegramMentionWordChar(next)) {
      return true;
    }
    startIndex = idx + 1;
  }
  return false;
}

async function resolveRelayIdentity(
  accountId: string,
  cache: Map<string, TelegramRelayIdentity | null>,
): Promise<TelegramRelayIdentity | null> {
  if (cache.has(accountId)) {
    return cache.get(accountId) ?? null;
  }
  const endpoint = relayEndpoints.get(accountId);
  if (!endpoint) {
    cache.set(accountId, null);
    return null;
  }
  try {
    const identity = await endpoint.resolveIdentity();
    cache.set(accountId, identity);
    return identity;
  } catch {
    cache.set(accountId, null);
    return null;
  }
}

function shouldRelayWithCooldown(params: {
  chainId: string;
  chatId: number | string;
  sourceAccountId: string;
  targetAccountId: string;
  nowMs: number;
}): boolean {
  const key = `${params.chainId}:${normalizeChatKey(params.chatId)}:${params.sourceAccountId}:${params.targetAccountId}`;
  const previous = relayCooldownByKey.get(key);
  if (previous != null && params.nowMs - previous < RELAY_COOLDOWN_MS) {
    return false;
  }
  relayCooldownByKey.set(key, params.nowMs);
  if (relayCooldownByKey.size > 2048) {
    cleanupCooldownEntries(params.nowMs);
  }
  return true;
}

function isValidRelayMeta(meta: unknown): meta is TelegramRelayChainMeta {
  if (!meta || typeof meta !== "object") {
    return false;
  }
  const typed = meta as TelegramRelayChainMeta;
  return (
    typeof typed.chainId === "string" &&
    typed.chainId.trim().length > 0 &&
    Number.isFinite(typed.turn) &&
    typed.turn >= 0 &&
    typeof typed.humanInitiated === "boolean"
  );
}

export function registerTelegramGroupRelayEndpoint(endpoint: TelegramRelayEndpoint): () => void {
  relayEndpoints.set(endpoint.accountId, endpoint);
  return () => {
    const current = relayEndpoints.get(endpoint.accountId);
    if (current === endpoint) {
      relayEndpoints.delete(endpoint.accountId);
    }
  };
}

export function trackTelegramRelayMessageOwner(params: TrackTelegramRelayMessageParams): void {
  if (!isFiniteMessageId(params.messageId)) {
    return;
  }
  const nowMs = params.recordedAtMs ?? Date.now();
  const chatKey = normalizeChatKey(params.chatId);
  let chatOwners = relayMessageOwners.get(chatKey);
  if (!chatOwners) {
    chatOwners = new Map();
    relayMessageOwners.set(chatKey, chatOwners);
  }
  chatOwners.set(params.messageId, {
    accountId: params.accountId,
    recordedAtMs: nowMs,
  });
  if (chatOwners.size > 512) {
    cleanupMessageOwners(chatOwners, nowMs);
  }
}

export function resolveTelegramRelayMessageOwner(
  chatId: number | string,
  messageId: number,
): string | undefined {
  if (!isFiniteMessageId(messageId)) {
    return undefined;
  }
  const chatOwners = relayMessageOwners.get(normalizeChatKey(chatId));
  if (!chatOwners) {
    return undefined;
  }
  cleanupMessageOwners(chatOwners, Date.now());
  return chatOwners.get(messageId)?.accountId;
}

export function attachTelegramRelayMeta(
  message: Message,
  relayMeta: TelegramRelayChainMeta,
): Message {
  (message as Message & { [RELAY_META_SYMBOL]?: TelegramRelayChainMeta })[RELAY_META_SYMBOL] =
    relayMeta;
  return message;
}

export function readTelegramRelayMeta(message: Message): TelegramRelayChainMeta | undefined {
  const relayMeta = (message as Message & { [RELAY_META_SYMBOL]?: TelegramRelayChainMeta })[
    RELAY_META_SYMBOL
  ];
  return isValidRelayMeta(relayMeta) ? relayMeta : undefined;
}

export async function publishTelegramGroupRelay(
  params: PublishTelegramGroupRelayParams,
): Promise<void> {
  const sentAtMs = params.sentAtMs ?? Date.now();
  trackTelegramRelayMessageOwner({
    chatId: params.chatId,
    messageId: params.messageId,
    accountId: params.sourceAccountId,
    recordedAtMs: sentAtMs,
  });

  if (!params.isGroup) {
    return;
  }
  if (!params.chain.humanInitiated) {
    return;
  }
  const nextTurn = params.chain.turn + 1;
  if (nextTurn > RELAY_MAX_TURNS) {
    return;
  }

  const text = params.text?.trim() ?? "";
  const identityCache = new Map<string, TelegramRelayIdentity | null>();
  const sourceIdentity = await resolveRelayIdentity(params.sourceAccountId, identityCache);

  for (const endpoint of relayEndpoints.values()) {
    if (endpoint.accountId === params.sourceAccountId) {
      continue;
    }

    const targetIdentity = await resolveRelayIdentity(endpoint.accountId, identityCache);
    const mentionedTarget = textMentionsBot(text, targetIdentity?.botUsername ?? "");
    const replyTargetsRecipient =
      params.replyToMessageId != null &&
      resolveTelegramRelayMessageOwner(params.chatId, params.replyToMessageId) ===
        endpoint.accountId;
    if (!mentionedTarget && !replyTargetsRecipient) {
      continue;
    }
    if (
      !shouldRelayWithCooldown({
        chainId: params.chain.chainId,
        chatId: params.chatId,
        sourceAccountId: params.sourceAccountId,
        targetAccountId: endpoint.accountId,
        nowMs: sentAtMs,
      })
    ) {
      continue;
    }

    await endpoint.handleRelay({
      chatId: params.chatId,
      messageId: params.messageId,
      messageThreadId: params.messageThreadId,
      text,
      sentAtMs,
      replyToMessageId: params.replyToMessageId,
      replyTargetsRecipient,
      source: {
        accountId: params.sourceAccountId,
        botUserId: sourceIdentity?.botUserId,
        botUsername: sourceIdentity?.botUsername,
        botDisplayName: sourceIdentity?.botDisplayName,
      },
      target: {
        accountId: endpoint.accountId,
        botUserId: targetIdentity?.botUserId,
        botUsername: targetIdentity?.botUsername,
        botDisplayName: targetIdentity?.botDisplayName,
      },
      relayMeta: {
        chainId: params.chain.chainId,
        turn: nextTurn,
        humanInitiated: params.chain.humanInitiated,
      },
    });
  }
}

export function clearTelegramGroupRelayState(): void {
  relayEndpoints.clear();
  relayMessageOwners.clear();
  relayCooldownByKey.clear();
}
