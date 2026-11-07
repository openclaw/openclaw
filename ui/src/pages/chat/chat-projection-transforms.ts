import {
  readSessionMessageIdentity,
  type SessionProjectionScope,
  type SessionProjectionState,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatInputDeliveryEvent } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";

export type ChatInputDeliveryReceipt = Pick<
  ChatInputDeliveryEvent,
  "delivery" | "seq" | "targetRunId"
>;
const MAX_CHAT_INPUT_DELIVERIES = 256;

export function projectChatInputDeliveries(
  projection: SessionProjectionState,
  receipts?: ReadonlyMap<string, ChatInputDeliveryReceipt>,
): SessionProjectionState {
  let changed = false;
  const entries = projection.entries.map((entry) => {
    const message = asNullableRecord(entry.message);
    const metadata = asNullableRecord(message?.["__openclaw"]);
    const identity = receipts?.size ? readSessionMessageIdentity(entry.message) : undefined;
    const key = identity?.role === "user" ? identity.idempotencyKey : undefined;
    const receipt = key?.endsWith(":user") ? receipts?.get(key.slice(0, -5)) : undefined;
    if (!message || (!receipt && !metadata?.inputDelivery) || metadata?.inputDelivery === receipt) {
      return entry;
    }
    const { inputDelivery: _previous, ...rest } = metadata ?? {};
    changed = true;
    return {
      ...entry,
      message: {
        ...message,
        __openclaw: { ...rest, ...(receipt ? { inputDelivery: receipt } : {}) },
      },
    };
  });
  return changed
    ? { ...projection, entries, messages: entries.map((entry) => entry.message) }
    : projection;
}

export function reduceChatInputDeliveries(
  current: ReadonlyMap<string, ChatInputDeliveryReceipt> | undefined,
  event: ChatInputDeliveryEvent,
): Map<string, ChatInputDeliveryReceipt> | undefined {
  const previous = current?.get(event.runId);
  if (previous && (previous.seq >= event.seq || previous.delivery === "read")) {
    return undefined;
  }
  const receipts = new Map(current);
  receipts.set(event.runId, {
    delivery: event.delivery,
    seq: event.seq,
    ...(event.targetRunId ? { targetRunId: event.targetRunId } : {}),
  });
  // Live-only feedback: bound receipts for missed/evicted rows without timers or history polls.
  if (receipts.size > MAX_CHAT_INPUT_DELIVERIES) {
    const oldest = receipts.keys().next().value;
    if (oldest !== undefined) {
      receipts.delete(oldest);
    }
  }
  return receipts;
}

// Display ownership outlives active-state cleanup. It is not the foreground
// terminal fence: an unowned final cannot suppress authoritative active rows.
export const CHAT_PROJECTION_SCOPE_KEYS = [
  "sessionKey",
  "sessionId",
  "agentId",
  "lifecycleRevision",
  "activeLeafEntryId",
] as const;

export function chatProjectionScopeChanged(
  previous: SessionProjectionScope,
  scope: SessionProjectionScope,
  keys: readonly (keyof SessionProjectionScope)[] = CHAT_PROJECTION_SCOPE_KEYS,
) {
  return keys.some(
    (key) =>
      Object.hasOwn(scope, key) && previous[key] !== undefined && previous[key] !== scope[key],
  );
}
