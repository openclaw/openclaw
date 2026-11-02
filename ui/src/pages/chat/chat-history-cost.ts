import {
  nativeHistoryMessageSourceIdentity,
  nativeHistoryMessageSourceId,
} from "../../lib/chat/history-message-identity.ts";
import { serializedMessageArrayWeight } from "../../lib/chat/message-weight.ts";

// Counts admitted message entries, before renderer grouping. Source groups and
// lifecycle-owned pins are indivisible exceptions, not a whole-pane heap bound.
export const CHAT_RESIDENT_ENTRY_TARGET = 400;
export const CHAT_RESIDENT_WEIGHT_TARGET = 3 * 1024 * 1024;
export function messageWeight(message: unknown): number {
  return serializedMessageArrayWeight(message) - 1;
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

export function intrinsicGroup(group: { count: number; weight: number } | undefined) {
  return Boolean(
    group &&
    (group.count > CHAT_RESIDENT_ENTRY_TARGET || group.weight + 1 > CHAT_RESIDENT_WEIGHT_TARGET),
  );
}
