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

export function intrinsicGroup(group: { count: number; weight: number } | undefined) {
  return Boolean(
    group &&
    (group.count > CHAT_RESIDENT_ENTRY_TARGET || group.weight + 1 > CHAT_RESIDENT_WEIGHT_TARGET),
  );
}

/** Record the indivisible source at admission, before ordinary resident publication. */
export function intrinsicChatHistorySource(messages: readonly unknown[]) {
  return [...sourceGroups(messages)].findLast(([, group]) => intrinsicGroup(group))?.[0];
}
