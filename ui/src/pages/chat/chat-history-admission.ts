import { nativeHistoryMessageSourceIdentity } from "../../lib/chat/history-message-identity.ts";
import {
  CHAT_RESIDENT_WEIGHT_TARGET,
  intrinsicGroup,
  messageWeight,
  sourceGroups,
} from "./chat-history-cost.ts";

/** Charge uncovered pin occurrences; retained sources credit only their exact overlap. */
function prepareChatHistoryPinCost(messages: readonly unknown[], pins: readonly unknown[]) {
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

/** Page admission carries source-only protection and scalar pin credits into the hot selector. */
export function prepareChatHistoryAdmission(
  messages: readonly unknown[],
  pages: readonly import("./chat-history-pagination.ts").ChatHistorySegment[],
  visibleSources: readonly string[],
  pins: readonly unknown[],
): import("./chat-history-window.ts").ChatHistoryResidencyAdmission {
  const ordered = pages.flatMap((segment) => segment.sources);
  const visible = new Set(visibleSources);
  const firstVisible = ordered.findIndex((source) => visible.has(source));
  const lastVisible = ordered.findLastIndex((source) => visible.has(source));
  return {
    pages,
    protectedSources: new Set(firstVisible < 0 ? [] : ordered.slice(firstVisible, lastVisible + 1)),
    pinCost: prepareChatHistoryPinCost(messages, pins),
  };
}
