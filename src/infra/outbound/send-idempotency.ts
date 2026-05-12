import { createHash } from "node:crypto";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { QueuedRenderedMessageBatchPlan } from "./delivery-queue-storage.js";

const OUTBOUND_SEND_IDEMPOTENCY_STATE = Symbol.for(
  "openclaw.outbound.explicit-send-idempotency.v1",
);
const OUTBOUND_SEND_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const OUTBOUND_SEND_IDEMPOTENCY_MAX_SENT = 1_000;

type OutboundSendIdempotencyState = {
  inFlight: Set<string>;
  sent: Map<string, number>;
};

export type OutboundSendIdempotencyResult<T> =
  | { status: "executed"; value: T }
  | { status: "duplicate"; value: T };

function resolveOutboundSendIdempotencyState(): OutboundSendIdempotencyState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[OUTBOUND_SEND_IDEMPOTENCY_STATE];
  if (existing && typeof existing === "object") {
    return existing as OutboundSendIdempotencyState;
  }
  const created: OutboundSendIdempotencyState = {
    inFlight: new Set<string>(),
    sent: new Map<string, number>(),
  };
  globalStore[OUTBOUND_SEND_IDEMPOTENCY_STATE] = created;
  return created;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

function pruneSent(state: OutboundSendIdempotencyState, now: number): void {
  const cutoff = now - OUTBOUND_SEND_IDEMPOTENCY_TTL_MS;
  for (const [key, timestamp] of state.sent) {
    if (timestamp < cutoff) {
      state.sent.delete(key);
    }
  }
  while (state.sent.size > OUTBOUND_SEND_IDEMPOTENCY_MAX_SENT) {
    const firstKey = state.sent.keys().next().value;
    if (!firstKey) {
      break;
    }
    state.sent.delete(firstKey);
  }
}

function digestStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 32);
}

function normalizeThreadId(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const text = String(value).trim();
  return text || undefined;
}

export function buildOutboundSendIdempotencyKey(params: {
  idempotencyKey?: string | null;
  channel: string;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
  replyToId?: string | null;
  replyToMode?: string | null;
  payloads: readonly ReplyPayload[];
  renderedBatchPlan?: QueuedRenderedMessageBatchPlan;
}): string | undefined {
  const idempotencyKey =
    typeof params.idempotencyKey === "string" ? params.idempotencyKey.trim() : "";
  if (!idempotencyKey) {
    return undefined;
  }
  const routeAndContentDigest = digestStable({
    channel: params.channel,
    to: params.to,
    accountId: params.accountId ?? undefined,
    threadId: normalizeThreadId(params.threadId),
    replyToId: params.replyToId ?? undefined,
    replyToMode: params.replyToMode ?? undefined,
    payloads: params.payloads,
    renderedBatchPlan: params.renderedBatchPlan,
  });
  return `${idempotencyKey}:${routeAndContentDigest}`;
}

export async function runOutboundSendOnce<T>(params: {
  key?: string;
  duplicateValue: T;
  shouldRemember?: (value: T) => boolean;
  run: () => Promise<T>;
}): Promise<OutboundSendIdempotencyResult<T>> {
  const key = params.key;
  if (!key) {
    return { status: "executed", value: await params.run() };
  }

  const state = resolveOutboundSendIdempotencyState();
  const now = Date.now();
  pruneSent(state, now);
  if (state.inFlight.has(key) || state.sent.has(key)) {
    return { status: "duplicate", value: params.duplicateValue };
  }

  state.inFlight.add(key);
  try {
    const value = await params.run();
    if (params.shouldRemember?.(value) ?? true) {
      state.sent.set(key, Date.now());
      pruneSent(state, Date.now());
    }
    return { status: "executed", value };
  } catch (error) {
    state.sent.delete(key);
    throw error;
  } finally {
    state.inFlight.delete(key);
  }
}

export function resetOutboundSendIdempotencyForTest(): void {
  const state = resolveOutboundSendIdempotencyState();
  state.inFlight.clear();
  state.sent.clear();
}
