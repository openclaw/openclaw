import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { extractAssistantText, stripToolMessages } from "../agents/tools/chat-history-text.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  readSessionTranscriptBoundedContextMessageTailPage,
} from "../config/sessions/session-accessor.js";
import { redactToolPayloadText } from "../logging/redact.js";
import type { SessionCompanionSeedMessage } from "./session-companion-state.js";

const SEED_MAX_MESSAGES = 40;
const SEED_MAX_BYTES = 24 * 1024;
const SEED_MESSAGE_MAX_CHARS = 4000;
const SEED_READ_PAGE_MESSAGES = SEED_MAX_MESSAGES * 4 + 1;
const SEED_READ_MAX_SCANNED_MESSAGES = 4_096;
const SEED_READ_MAX_BYTES = 1024 * 1024;

function normalizeSeedText(value: string): string {
  return truncateUtf16Safe(
    redactToolPayloadText(value).replace(/\s+/gu, " ").trim(),
    SEED_MESSAGE_MAX_CHARS,
  );
}

function extractUserText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return normalizeSeedText(content) || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((block) => {
      if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") {
        return [];
      }
      const blockText = (block as { text?: unknown }).text;
      return typeof blockText === "string" ? [blockText] : [];
    })
    .join("\n");
  return normalizeSeedText(text) || undefined;
}

function readMessageTimestamp(message: unknown): number {
  if (!message || typeof message !== "object") {
    return 0;
  }
  const value = (message as { timestamp?: unknown }).timestamp;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function sanitizeSeedMessages(messages: unknown[]): SessionCompanionSeedMessage[] {
  const sanitized = stripToolMessages(messages)
    .slice(-SEED_MAX_MESSAGES)
    .flatMap((message): SessionCompanionSeedMessage[] => {
      if (!message || typeof message !== "object") {
        return [];
      }
      const role = (message as { role?: unknown }).role;
      const text =
        role === "assistant"
          ? normalizeSeedText(extractAssistantText(message) ?? "")
          : role === "user"
            ? extractUserText(message)
            : undefined;
      return text && (role === "assistant" || role === "user")
        ? [{ role, text, ts: readMessageTimestamp(message) }]
        : [];
    });
  const selected: SessionCompanionSeedMessage[] = [];
  let bytes = 2;
  for (const message of sanitized.toReversed()) {
    const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
    if (bytes + messageBytes > SEED_MAX_BYTES) {
      break;
    }
    selected.unshift(message);
    bytes += messageBytes;
  }
  return selected;
}

function isTrailingUserMessage(message: unknown): boolean {
  return (
    Boolean(message) &&
    typeof message === "object" &&
    (message as { role?: unknown }).role === "user"
  );
}

function readPageMessages(events: Array<{ event: unknown }>): unknown[] {
  return events.flatMap(({ event }) => {
    if (!event || typeof event !== "object") {
      return [];
    }
    const message = (event as { message?: unknown }).message;
    return message && typeof message === "object" ? [message] : [];
  });
}

export function readSessionCompanionSeedMessages(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
}): SessionCompanionSeedMessage[] {
  try {
    const scope = {
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    };
    const messages: unknown[] = [];
    let offset = 0;
    let serializedBytes = 0;
    let totalMessages = Number.POSITIVE_INFINITY;
    while (
      stripToolMessages(messages).length < SEED_MAX_MESSAGES &&
      offset < totalMessages &&
      offset < SEED_READ_MAX_SCANNED_MESSAGES &&
      serializedBytes < SEED_READ_MAX_BYTES
    ) {
      const page = readSessionTranscriptBoundedContextMessageTailPage(scope, {
        maxBytes: SEED_READ_MAX_BYTES - serializedBytes,
        maxMessages: Math.min(SEED_READ_PAGE_MESSAGES, SEED_READ_MAX_SCANNED_MESSAGES - offset),
        offset,
      });
      totalMessages = page.totalMessages;
      if (page.scannedMessages === 0) {
        break;
      }
      const pageMessages = readPageMessages(page.events);
      if (offset === 0 && isTrailingUserMessage(pageMessages.at(-1))) {
        pageMessages.pop();
      }
      messages.unshift(...pageMessages);
      offset += page.scannedMessages;
      serializedBytes += page.serializedBytes;
    }
    return sanitizeSeedMessages(messages);
  } catch (error) {
    if (isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    return [];
  }
}
