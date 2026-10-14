import type { SessionCompanionExchange } from "../../packages/gateway-protocol/src/schema/sessions.js";

export type SessionCompanionContextMessage = {
  role: "assistant" | "user";
  text: string;
  ts: number;
};

export type SessionCompanionPreparedContext = {
  empty: boolean;
  messages: SessionCompanionContextMessage[];
  sessionId: string;
};

export type SessionCompanionThread = {
  context: SessionCompanionPreparedContext;
  digestText: string;
  exchanges: SessionCompanionExchange[];
  lastNoteSequence: number;
  busy: boolean;
  lastUsedAt: number;
};

const SESSION_COMPANION_MAX_EXCHANGES = 24;
const SESSION_COMPANION_MAX_EXCHANGE_BYTES = 48 * 1024;

export function selectSessionCompanionReferenceItems<T>(
  newestFirst: readonly T[],
  maxBytes: number,
): T[] {
  const selected: T[] = [];
  let bytes = 2;
  for (const item of newestFirst) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (bytes + itemBytes > maxBytes) {
      break;
    }
    selected.push(item);
    bytes += itemBytes;
  }
  return selected.toReversed();
}

function exchangeBytes(exchange: SessionCompanionExchange): number {
  return Buffer.byteLength(exchange.question, "utf8") + Buffer.byteLength(exchange.answer, "utf8");
}

export function trimSessionCompanionExchanges(exchanges: SessionCompanionExchange[]): void {
  let bytes = exchanges.reduce((total, exchange) => total + exchangeBytes(exchange), 0);
  // Dropping the oldest exchange intentionally breaks the replay byte prefix;
  // the count and byte caps take priority once a long-lived thread is bounded.
  while (
    exchanges.length > SESSION_COMPANION_MAX_EXCHANGES ||
    bytes > SESSION_COMPANION_MAX_EXCHANGE_BYTES
  ) {
    const removed = exchanges.shift();
    bytes -= removed ? exchangeBytes(removed) : 0;
  }
}
