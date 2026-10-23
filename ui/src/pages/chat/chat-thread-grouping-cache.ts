import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatItem, MessageGroup } from "../../lib/chat/chat-types.ts";
import { resolveMessageDisplayMarkdown } from "../../lib/chat/message-display.ts";
import { normalizeMessage, normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { resolveMessageVisibleContent } from "../../lib/chat/message-visibility.ts";
import { chatItemStartsDisplayTurn } from "./chat-turn-boundary.ts";

/** Search hides rows, not turns: a row after a hidden turn start never joins the group before it. */
export function rowsAfterHiddenTurns(items: ChatItem[], context: ChatItem[]): Set<string> {
  const visible = new Set(items.map((item) => item.key));
  const rows = new Set<string>();
  let hiddenTurn = false;
  for (const item of context) {
    if (!visible.has(item.key)) {
      hiddenTurn ||= chatItemStartsDisplayTurn(item);
    } else if (hiddenTurn) {
      rows.add(item.key);
      hiddenTurn = false;
    }
  }
  return rows;
}

export function createChatItemsGroupingCache(
  groupChatItemSegment: (
    items: ChatItem[],
    visibleReasoning: ReadonlySet<string>,
    rowsAfterHiddenTurn?: ReadonlySet<string>,
    showReasoning?: boolean,
  ) => Array<ChatItem | MessageGroup>,
) {
  const groupedSegments = new WeakMap<
    object,
    { inputs: unknown[]; items: Array<ChatItem | MessageGroup> }
  >();

  return function groupChatItems(
    items: ChatItem[],
    visibleReasoning: ReadonlySet<string>,
    rowsAfterHiddenTurn?: ReadonlySet<string>,
    showReasoning = false,
  ): Array<ChatItem | MessageGroup> {
    const reasoningKey = JSON.stringify([...visibleReasoning]);
    const result: Array<ChatItem | MessageGroup> = [];
    let source: Array<Extract<ChatItem, { kind: "message" }>> = [];
    const flush = () => {
      if (source.length === 0) {
        return;
      }
      const owner = asRecord(source[0]?.message);
      const inputs: unknown[] = [reasoningKey, showReasoning];
      for (const item of source) {
        inputs.push(
          item.key,
          item.message,
          normalizeMessage(item.message),
          item.duplicateCount,
          item.startsTurn,
          rowsAfterHiddenTurn?.has(item.key) === true,
        );
      }
      const cached = owner && groupedSegments.get(owner);
      // Duplicate collapse annotates wrappers, never the retained cache inputs.
      const grouped =
        cached &&
        cached.inputs.length === inputs.length &&
        inputs.every((input, index) => input === cached.inputs[index])
          ? cached.items
          : groupChatItemSegment(
              source.map((item) => ({ ...item })),
              visibleReasoning,
              rowsAfterHiddenTurn,
              showReasoning,
            );
      if (grouped !== cached?.items) {
        const segment = { inputs, items: grouped };
        // Hidden or retained source objects must not keep overlapping old snapshots alive.
        for (const item of source) {
          const message = asRecord(item.message);
          if (message) {
            const previous = groupedSegments.get(message);
            if (previous && previous !== segment && previous.inputs.length > 0) {
              previous.inputs = [];
              previous.items = [];
            }
            groupedSegments.set(message, segment);
          }
        }
      }
      // Attribution is transcript-wide and must never annotate cached local groups.
      for (const item of grouped) {
        result.push(item.kind === "group" ? { ...item } : item);
      }
      source = [];
    };
    for (const [index, item] of items.entries()) {
      if (item.kind !== "message") {
        flush();
        result.push(item);
        continue;
      }
      const previous = items[index - 1];
      if (
        previous?.kind === "message" &&
        normalizeRoleForGrouping(normalizeMessage(item.message).role) === "user"
      ) {
        const normalized = normalizeMessage(previous.message);
        const role = normalizeRoleForGrouping(normalized.role);
        // A visible non-user row guarantees a grouping and duplicate boundary.
        // Keep hidden rows and consecutive inputs together for the canonical grouper.
        if (
          role !== "user" &&
          (role !== "assistant" ||
            resolveMessageVisibleContent(previous.message, normalized) === "non-text" ||
            resolveMessageDisplayMarkdown(previous.message, normalized).trim())
        ) {
          flush();
        }
      }
      source.push(item);
    }
    flush();
    return result;
  };
}
