import { randomUUID } from "node:crypto";
import type { AgentAssistantSourceReceipt } from "../infra/agent-events.js";
import { mergeAssistantText, type AssistantTextSnapshot } from "./agent-event-assistant-text.js";
import {
  capLiveAssistantText,
  type createLiveAssistantTextProjection,
} from "./live-chat-projector.js";

export type ChatRunBufferState = {
  rawBuffer?: string;
  rawOffset?: number;
  /** Positions are absolute; null ends retain identity facts after a source replacement. */
  assistantItems?: Map<
    string | symbol | undefined,
    {
      itemId?: string;
      committed?: true;
      start?: number;
      end?: number | null;
      scope?: number;
      publishThinkingReceipt?: (messageId: string, sessionKey?: string, sessionId?: string) => void;
    }
  >;
  assistantScope?: AssistantTextSnapshot["scope"];
  assistantScopeOffset?: number;
  assistantOccurrenceId?: string;
  managedMediaUrls?: Set<string>;
  display?: {
    projector: ReturnType<typeof createLiveAssistantTextProjection>;
    current: ReturnType<ReturnType<typeof createLiveAssistantTextProjection>["replace"]>;
    pendingRawDelta?: string | null;
    reset?: boolean;
    unsentDelta: string | null;
    sentText?: string;
  };
};

type BufferInput = Parameters<typeof mergeAssistantText>[1];

const invalidateRange = (item: { start?: number; end?: number | null }) => {
  delete item.start;
  item.end = null;
};

export const bufferVisibleText = (record: ChatRunBufferState) => {
  const text = record.rawBuffer ?? "";
  const offset = record.rawOffset ?? 0;
  const items = [...(record.assistantItems?.values() ?? [])]
    .filter((item) => typeof item.end === "number" && item.end > offset)
    .toSorted((a, b) => (a.start ?? 0) - (b.start ?? 0));
  if (!items.some((item) => item.committed)) {
    return text;
  }
  let visible = "";
  let cursor = offset;
  let gap = "";
  let scope: number | undefined;
  for (const item of items) {
    if (typeof item.end !== "number") {
      continue;
    }
    const start = Math.max(offset, item.start ?? 0);
    gap += text.slice(cursor - offset, start - offset);
    cursor = Math.max(cursor, item.end);
    if (item.committed) {
      continue;
    }
    let part = text.slice(start - offset, item.end - offset);
    if (!part) {
      continue;
    }
    if (!visible && (item.start ?? 0) > offset) {
      // Retired native boundaries do not leave presentation padding in the tail.
      part = part.replace(/^\n{1,2}/, "");
    } else if (visible && scope !== item.scope) {
      const trailing = visible.endsWith("\n\n") ? 2 : visible.endsWith("\n") ? 1 : 0;
      const leading = part.startsWith("\n\n") ? 2 : part.startsWith("\n") ? 1 : 0;
      visible += "\n".repeat(Math.max(0, 2 - trailing - leading));
    } else if (visible) {
      // Unscoped corrections can retain native padding between owned intervals.
      visible += gap;
    }
    visible += part;
    gap = "";
    scope = item.scope;
  }
  return visible;
};

export const updateBuffer = (
  record: ChatRunBufferState,
  incoming: BufferInput,
  source?: AgentAssistantSourceReceipt,
) => {
  const sourceId = source ? (source.itemId ??= randomUUID()) : undefined;
  const itemId = sourceId ?? incoming.occurrenceId ?? incoming.itemId;
  // Embedded messages have their own merge scope; native occurrences share one.
  const input = sourceId ? { ...incoming, itemId: sourceId } : incoming;
  const display = record.display;
  if (input.managedMediaUrls?.length) {
    const urls = (record.managedMediaUrls ??= new Set<string>());
    const previousSize = urls.size;
    input.managedMediaUrls.forEach((url) => urls.add(url));
    if (display && urls.size !== previousSize) {
      display.reset = true;
    }
  }
  const previous = record.rawBuffer ?? "";
  const items = (record.assistantItems ??= new Map());
  if (source) {
    retireSource(record, source);
  }
  const item = items.get(itemId) ?? {};
  if (
    itemId !== undefined &&
    itemId !== record.assistantOccurrenceId &&
    item.committed &&
    (item.end !== undefined ||
      (bufferVisibleText(record).length > 0 && !(input.replace && input.replaceable)))
  ) {
    // Closed occurrences cannot reopen over a newer live owner.
    item.end ??= null;
    items.set(itemId, item);
    return previous;
  }
  const previousOccurrence = items.get(record.assistantOccurrenceId);
  const anonymous = itemId ? items.get(undefined) : undefined;
  if (anonymous) {
    items.set(Symbol("anonymous assistant interval"), anonymous);
    items.delete(undefined);
  }
  const sameItem = input.itemId && input.itemId === record.assistantScope?.itemId;
  const retainedOffset = record.rawOffset ?? 0;
  const previousEnd = retainedOffset + previous.length;
  const canAppendRawDelta =
    previous.length === 0 ||
    (previousOccurrence !== undefined &&
      !previousOccurrence.committed &&
      previousOccurrence.end === previousEnd &&
      (previousOccurrence.start ?? previousEnd) < previousEnd);
  const oldScopeOffset = record.assistantScopeOffset;
  const snapshot = mergeAssistantText(
    { text: previous, scope: record.assistantScope },
    input,
    "live",
  );
  if (
    itemId &&
    (itemId !== record.assistantOccurrenceId || (input.itemId && !sameItem)) &&
    typeof item.end === "number"
  ) {
    // A returning identity or a new native scope leaves the earlier interval intact.
    items.set(Symbol("earlier occurrence interval"), { ...item });
    invalidateRange(item);
  }
  const resetSource =
    (!itemId && snapshot.appendedText === undefined) ||
    (input.replace && input.replaceable && !sameItem);
  const sourceOffset =
    resetSource || (!input.itemId && snapshot.text === input.text)
      ? 0
      : sameItem &&
          input.text !== undefined &&
          snapshot.scope &&
          oldScopeOffset !== undefined &&
          retainedOffset > oldScopeOffset
        ? Math.min(
            retainedOffset,
            oldScopeOffset - snapshot.scope.prefix.length - snapshot.scope.separatorLength,
          )
        : retainedOffset;
  const end = sourceOffset + snapshot.text.length;
  const scopeOffset = snapshot.scope
    ? sameItem && input.text === undefined
      ? oldScopeOffset
      : sourceOffset + snapshot.scope.prefix.length + snapshot.scope.separatorLength
    : undefined;
  let commonEnd = Math.min(retainedOffset, end);
  if (snapshot.appendedText !== undefined) {
    commonEnd = previousEnd;
  } else {
    const limit = Math.min(previousEnd, end);
    while (commonEnd < limit) {
      const point = previous.codePointAt(commonEnd - retainedOffset);
      if (point !== snapshot.text.codePointAt(commonEnd - sourceOffset)) {
        break;
      }
      commonEnd += point !== undefined && point > 0xffff ? 2 : 1;
    }
  }
  const replacing = commonEnd < previousEnd;
  if (resetSource) {
    for (const observed of items.values()) {
      if (observed.end !== undefined) {
        invalidateRange(observed);
      }
    }
  } else if (replacing || input.replace) {
    for (const observed of items.values()) {
      if (typeof observed.end === "number") {
        observed.end = Math.min(observed.end, commonEnd);
        observed.start = Math.min(observed.start ?? 0, commonEnd);
      }
    }
  }
  let scope = sameItem ? (previousOccurrence?.scope ?? scopeOffset) : (scopeOffset ?? sourceOffset);
  if (!snapshot.scope) {
    let through = sourceOffset;
    for (const observed of items.values()) {
      if (
        typeof observed.end === "number" &&
        observed.end > through &&
        observed.end <= commonEnd &&
        observed.end > (observed.start ?? 0)
      ) {
        through = observed.end;
        scope = observed.scope;
      }
    }
  }
  const restoredUnknown =
    !resetSource &&
    input.text !== undefined &&
    sourceOffset < retainedOffset &&
    [...items.values()].some(
      (observed) =>
        (!snapshot.scope || observed.scope === scope) &&
        typeof observed.end === "number" &&
        observed.end > (observed.start ?? 0) &&
        observed.itemId !== itemId,
    );
  if (restoredUnknown) {
    // The cap discards content: identical retained states can require different
    // ownership even for matching suffixes. Keep this replacement unowned rather
    // than hiding unsaved text behind a receipt for an unknowable old prefix.
    for (const observed of items.values()) {
      if ((!snapshot.scope || observed.scope === scope) && observed.end !== undefined) {
        invalidateRange(observed);
      }
    }
    items.set(Symbol("restored unknown text"), { start: scopeOffset ?? sourceOffset, end, scope });
  }
  const start = resetSource
    ? (scopeOffset ?? 0)
    : sameItem
      ? Math.max(scopeOffset ?? 0, Math.min(item.start ?? previousEnd, commonEnd))
      : (scopeOffset ?? item.start ?? commonEnd);
  item.start = restoredUnknown ? end : start;
  item.end = end;
  item.itemId = itemId;
  item.scope = scope;
  items.set(itemId, item);
  record.assistantScope = snapshot.scope;
  record.assistantScopeOffset = scopeOffset;
  record.assistantOccurrenceId = itemId;
  const text = capLiveAssistantText(snapshot);
  record.rawOffset = sourceOffset + snapshot.text.length - text.length;
  record.rawBuffer = text;
  if (display) {
    display.reset ||=
      text.length !== snapshot.text.length ||
      input.replace === true ||
      replacing ||
      item.committed === true;
    display.pendingRawDelta =
      snapshot.appendedText !== undefined &&
      display.pendingRawDelta !== null &&
      !display.reset &&
      canAppendRawDelta
        ? (display.pendingRawDelta ?? "") + snapshot.appendedText
        : null;
  }
  return text;
};

export const retireBuffer = (record: ChatRunBufferState, itemIds: readonly string[]) => {
  const items = (record.assistantItems ??= new Map());
  let changed = false;
  for (const itemId of itemIds) {
    const item = items.get(itemId);
    changed ||= !item?.committed && typeof item?.end === "number";
    items.set(itemId, { ...item, committed: true });
    for (const observed of items.values()) {
      if (observed.itemId === itemId) {
        changed ||= !observed.committed && typeof observed.end === "number";
        observed.committed = true;
      }
    }
  }
  if (changed && record.display) {
    record.display.reset = true;
  }
  return changed;
};

export const retireSource = (
  record: ChatRunBufferState | undefined,
  source: AgentAssistantSourceReceipt,
) => {
  if (!record || source.committedMessageSeq === undefined) {
    return false;
  }
  return retireBuffer(record, [(source.itemId ??= randomUUID())]);
};
