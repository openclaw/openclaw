import {
  reduceSessionProjection,
  type SessionProjectionState,
} from "@openclaw/gateway-client/browser";
import {
  nativeHistoryMessageSourceIdentity,
  nativeHistoryMessageSourceId,
} from "../../lib/chat/history-message-identity.ts";
import {
  CHAT_HISTORY_REQUEST_LIMIT,
  CHAT_HISTORY_REQUEST_MAX_BYTES,
  type ChatHistoryRequestBudget,
} from "./chat-history-request-params.ts";

// Counts admitted message entries, before renderer grouping. Source groups and
// lifecycle-owned pins are indivisible exceptions, not a whole-pane heap bound.
export const CHAT_RESIDENT_ENTRY_TARGET = 400;
export const CHAT_RESIDENT_WEIGHT_TARGET = 3 * 1024 * 1024;
const messageWeights = new WeakMap<object, number>();

export function messageWeight(message: unknown): number {
  if (message && typeof message === "object") {
    const cached = messageWeights.get(message);
    if (cached !== undefined) {
      return cached;
    }
    const weight = JSON.stringify([message]).length - 1;
    messageWeights.set(message, weight);
    return weight;
  }
  return JSON.stringify([message]).length - 1;
}

export function sourceGroups(messages: readonly unknown[]) {
  const groups = new Map<string, { count: number; weight: number; reopenable: boolean }>();
  for (const message of messages) {
    const source = nativeHistoryMessageSourceIdentity(message);
    if (source) {
      const previous = groups.get(source);
      groups.set(source, {
        count: (previous?.count ?? 0) + 1,
        weight: (previous?.weight ?? 0) + messageWeight(message),
        reopenable: Boolean(nativeHistoryMessageSourceId(message)),
      });
    }
  }
  return groups;
}

/** Charge uncovered pin occurrences; retained sources credit only their exact overlap. */
export function prepareChatHistoryPinCost(messages: readonly unknown[], pins: readonly unknown[]) {
  const occurrences = new Map<unknown, number>();
  const messageCounts = new Map<unknown, number>();
  for (const message of pins) {
    occurrences.set(message, (occurrences.get(message) ?? 0) + 1);
  }
  if (occurrences.size) {
    for (const message of messages) {
      messageCounts.set(message, (messageCounts.get(message) ?? 0) + 1);
    }
  }
  const groups = sourceGroups(pins);
  const covered = new Map<string, { count: number; weight: number }>();
  const cost = { count: 0, weight: 0, covered };
  for (const [message, count] of occurrences) {
    const source = nativeHistoryMessageSourceIdentity(message);
    // Lifecycle pins keep only their own indivisibility exception, including
    // a source-less provisional body. Neighbors never borrow that exception.
    if (
      source
        ? intrinsicGroup(groups.get(source))
        : messageWeight(message) + 1 > CHAT_RESIDENT_WEIGHT_TARGET
    ) {
      continue;
    }
    const weight = messageWeight(message);
    cost.count += count;
    cost.weight += count * weight;
    if (source !== null) {
      const overlap = Math.min(count, messageCounts.get(message) ?? 0);
      const previous = covered.get(source);
      covered.set(source, {
        count: (previous?.count ?? 0) + overlap,
        weight: (previous?.weight ?? 0) + overlap * weight,
      });
    }
  }
  return cost;
}

/** Estimate only the next wire read; exact admission still owns every exception. */
export function prepareChatHistoryRequestBudget(
  projection: SessionProjectionState,
  messages: readonly unknown[],
  requiredSources: ReadonlySet<string>,
  pinnedRunId?: string | null,
): ChatHistoryRequestBudget | undefined {
  const pins = reduceSessionProjection(projection, {
    type: "residencyChanged",
    messages: [],
    pinnedRunIds: pinnedRunId ? [pinnedRunId] : [],
  }).messages;
  const mandatory = new Set(requiredSources);
  for (const message of pins) {
    const source = nativeHistoryMessageSourceIdentity(message);
    if (source) {
      mandatory.add(source);
    }
  }
  const groups = sourceGroups(messages);
  if ([...requiredSources].some((source) => !groups.has(source))) {
    return undefined;
  }
  let count = 0;
  let weight = 1;
  const reserved = new Map<unknown, number>();
  const reserve = (values: readonly unknown[]) => {
    const occurrences = new Map<unknown, number>();
    for (const message of values) {
      const occurrence = (occurrences.get(message) ?? 0) + 1;
      occurrences.set(message, occurrence);
      if (occurrence > (reserved.get(message) ?? 0)) {
        count++;
        weight += messageWeight(message);
        reserved.set(message, occurrence);
      }
    }
  };
  const required = (message: unknown) =>
    mandatory.has(nativeHistoryMessageSourceIdentity(message) ?? "");
  // Count complete source fragments and repeated occurrences, then union pins
  // and the newest local reply without lending their atomicity exceptions.
  reserve(messages.filter(required));
  reserve(projection.messages.filter(required));
  reserve(pins);
  const local = projection.entries.findLast((entry) => entry.localOutput);
  if (local) {
    reserve([local.message]);
  }
  const limit = CHAT_RESIDENT_ENTRY_TARGET - count;
  // UTF-8 wire bytes consume at least as much as the JSON code-unit estimate.
  const maxBytes = CHAT_RESIDENT_WEIGHT_TARGET - weight;
  return limit > CHAT_HISTORY_REQUEST_LIMIT && maxBytes > CHAT_HISTORY_REQUEST_MAX_BYTES
    ? { limit, maxBytes }
    : undefined;
}

export function intrinsicGroup(group: { count: number; weight: number } | undefined) {
  return Boolean(
    group &&
    (group.count > CHAT_RESIDENT_ENTRY_TARGET || group.weight + 1 > CHAT_RESIDENT_WEIGHT_TARGET),
  );
}
