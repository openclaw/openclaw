import type { SessionProjectionEntry } from "@openclaw/gateway-client/browser";
import {
  nativeHistoryMessageSourceIdentity,
  nativeHistoryMessageSourceId,
} from "../../lib/chat/history-message-identity.ts";
import { prependUniqueNativeMessages } from "../../lib/chat/history-message-merge.ts";
import {
  CHAT_RESIDENT_WEIGHT_TARGET,
  intrinsicGroup,
  messageWeight,
  sourceGroups,
} from "./chat-history-cost.ts";
import type {
  ChatHistoryPagination,
  ChatTranscriptReaderSnapshot,
} from "./chat-history-pagination.ts";
import { type ChatHistoryResult, resolveChatHistoryPagination } from "./chat-history-snapshot.ts";
import {
  invalidateChatHistoryPacketSources,
  extendChatHistoryWindow,
  prepareChatHistorySegment,
  selectChatHistoryResidency,
  prepareChatHistoryResidencySegments,
} from "./chat-history-window.ts";
import type { ChatState } from "./chat-state-contract.ts";
import {
  readChatLocalOutputEntries,
  prepareChatHistoryProjectionMessages,
} from "./history-merge.ts";

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

/** Only a real source ID can reopen an interior cut. A bounded original packet
 * keeps both opaque edges while its unkeyed reader still owns that packet. */
function chatHistoryReaderBridge(
  messages: readonly unknown[],
  pagination: ChatHistoryPagination,
  reader: ChatTranscriptReaderSnapshot | null | undefined,
  direction: "older" | "newer",
): readonly string[] {
  const segments = pagination.segments ?? [];
  const covered = new Set(segments.flatMap((segment) => segment.sources));
  const visible = reader?.visibleSources.filter((source) => covered.has(source)) ?? [];
  const boundary = direction === "older" ? visible.at(-1) : visible[0];
  const index = segments.findIndex((segment) => boundary && segment.sources.includes(boundary));
  if (index < 0 || !boundary) {
    return [];
  }
  const segment = segments[index]!;
  const sourceIndex = segment.sources.indexOf(boundary);
  const intact =
    segment.boundedPacket &&
    reader?.anchor != null &&
    segment.sources.includes(reader.anchor) &&
    !messages.some(
      (message) =>
        nativeHistoryMessageSourceIdentity(message) === reader?.anchor &&
        nativeHistoryMessageSourceId(message),
    );
  return direction === "older"
    ? [
        ...segments.slice(0, index).flatMap((page) => page.sources),
        ...segment.sources.slice(0, intact ? undefined : sourceIndex + 1),
      ]
    : [
        ...segment.sources.slice(intact ? 0 : sourceIndex),
        ...segments.slice(index + 1).flatMap((page) => page.sources),
      ];
}

/** Prepare packet coverage without acquiring producer observations or publishing. */
export function prepareChatHistoryPages(
  state: Pick<ChatState, "chatMessages" | "chatHistoryPagination" | "readTranscriptReaderSnapshot">,
  results: readonly ChatHistoryResult[],
  direction: "older" | "newer" | "around",
  localEntries: readonly SessionProjectionEntry[] = readChatLocalOutputEntries(state),
  previousView?: {
    messages: readonly unknown[];
    pagination: ChatHistoryPagination;
    reader?: import("./chat-history-pagination.ts").ChatTranscriptReaderSnapshot | null;
    scope?: import("@openclaw/gateway-client/browser").SessionProjectionScope;
  },
) {
  const localOutputs = localEntries.map((entry) => entry.message);
  const previous = previousView?.messages ?? state.chatMessages;
  const previousPagination = previousView?.pagination ?? state.chatHistoryPagination;
  const reader =
    previousView?.reader !== undefined
      ? previousView.reader
      : state.readTranscriptReaderSnapshot?.();
  const held = previousPagination.segments ?? [
    prepareChatHistorySegment(previous, previousPagination, previousPagination.newerCursor),
  ];
  const required = new Set(
    direction === "around"
      ? []
      : chatHistoryReaderBridge(
          previous,
          { ...previousPagination, segments: held },
          reader,
          direction,
        ),
  );
  let messages = previous;
  let coverage = previousPagination;
  const movement = direction === "around" ? "tail" : direction;
  for (const result of results) {
    const incoming = result.messages ?? [];
    for (const message of incoming) {
      const source = nativeHistoryMessageSourceIdentity(message);
      if (source) {
        required.add(source);
      }
    }
    let packet = result.packet;
    let next = incoming;
    if (direction !== "around") {
      const merged =
        direction === "older"
          ? prependUniqueNativeMessages(incoming, messages, localEntries)
          : prependUniqueNativeMessages(messages, incoming, localEntries);
      const heldExpanded =
        direction === "older" ? merged.currentExpandedSources : merged.incomingExpandedSources;
      const incomingExpanded =
        direction === "older" ? merged.incomingExpandedSources : merged.currentExpandedSources;
      coverage = invalidateChatHistoryPacketSources(coverage, heldExpanded);
      if (packet?.boundedPacket && packet.sources.some((source) => incomingExpanded.has(source))) {
        packet = { ...packet, boundedPacket: undefined };
      }
      next = merged.messages;
    }
    coverage = extendChatHistoryWindow(
      coverage,
      messages,
      incoming,
      resolveChatHistoryPagination(result, coverage.totalMessages),
      result.newerCursor,
      movement,
      undefined,
      packet,
    );
    messages = next;
  }
  const transformed = prepareChatHistoryProjectionMessages(state, messages, previousView?.scope);
  messages = transformed.messages;
  coverage = invalidateChatHistoryPacketSources(coverage, transformed.changedSources);
  const covered = new Set(coverage.segments?.flatMap((segment) => segment.sources));
  const pinned = new Set(transformed.pins.map(nativeHistoryMessageSourceIdentity));
  const visible = direction === "around" ? [] : (reader?.visibleSources ?? []);
  const knownVisible = visible.every((source) => covered.has(source) || pinned.has(source));
  const pages = prepareChatHistoryResidencySegments(messages, coverage, localOutputs);
  const resident = selectChatHistoryResidency(
    messages,
    coverage,
    movement,
    reader?.anchor,
    localOutputs,
    pages ? prepareChatHistoryAdmission(messages, pages, visible, transformed.pins) : undefined,
  );
  const retained = new Set(resident.pagination.segments?.flatMap((segment) => segment.sources));
  // Incoming sources and the actual reader bridge must survive together.
  return {
    messages,
    pagination: resident.pagination,
    requiredSources: required,
    fits:
      knownVisible &&
      [...required].every((source) => retained.has(source)) &&
      resident.withinBudget,
  };
}
