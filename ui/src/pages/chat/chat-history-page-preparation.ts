import type { SessionProjectionEntry } from "@openclaw/gateway-client/browser";
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import {
  nativeHistoryMessageIdentity,
  nativeHistoryMessageSourceIdentity,
  nativeHistoryMessageSourceId,
} from "../../lib/chat/history-message-identity.ts";
import { prependUniqueNativeMessages } from "../../lib/chat/history-message-merge.ts";
import { prepareChatHistoryAdmission } from "./chat-history-admission.ts";
import { intrinsicChatHistorySource } from "./chat-history-cost.ts";
import { advanceChatHistoryNavigation } from "./chat-history-pagination.ts";
import type {
  ChatHistoryPagination,
  ChatHistorySegment,
  ChatTranscriptReaderSnapshot,
} from "./chat-history-pagination.ts";
import { type ChatHistoryResult, resolveChatHistoryPagination } from "./chat-history-snapshot.ts";
import {
  invalidateChatHistoryPacketSources,
  prepareChatHistoryTail,
  prepareChatHistorySegment,
  selectChatHistoryResidency,
  prepareChatHistoryResidencySegments,
} from "./chat-history-window.ts";
import type { ChatState } from "./chat-state-contract.ts";
import {
  readChatLocalOutputEntries,
  prepareChatHistoryProjectionMessages,
} from "./history-merge.ts";

function retainedRawHistoryStart(pagination: ChatHistoryPagination): number | null {
  const totalMessages = asSafeIntegerInRange(pagination.totalMessages, { min: 0 });
  if (totalMessages === undefined) {
    return null;
  }
  const retainedDepth = pagination.hasMore ? pagination.nextOffset : totalMessages;
  if (retainedDepth === undefined) {
    return null;
  }
  const start = totalMessages - retainedDepth + 1;
  return asSafeIntegerInRange(start, { min: 1 }) ?? null;
}

export function reconcileHistoryTail(options: {
  nextMessages: unknown[];
  nextPagination: ChatHistoryPagination;
  nextSessionId: string | null;
  previousMessages: unknown[];
  previousPagination: ChatHistoryPagination;
  previousSessionId: string | null;
}): { messages: unknown[]; pagination: ChatHistoryPagination; retainedCoverage?: true } | null {
  if (!options.previousSessionId || options.previousSessionId !== options.nextSessionId) {
    return null;
  }
  if (options.previousPagination.hasNewer) {
    // A background tail refresh is not contiguous with a detached reader.
    // Latest explicitly resets this window; never stitch across the newer gap.
    return { messages: options.previousMessages, pagination: options.previousPagination };
  }
  const previousByIdentity = new Map<string, unknown[]>();
  const previousSources = new Set<string>();
  const changedSources = new Set<string>();
  for (const message of options.previousMessages) {
    const source = nativeHistoryMessageSourceIdentity(message);
    if (source) {
      previousSources.add(source);
    }
    const identity = nativeHistoryMessageIdentity(message);
    if (identity) {
      const matches = previousByIdentity.get(identity) ?? [];
      matches.push(message);
      previousByIdentity.set(identity, matches);
    }
  }
  // Identical history rows keep their render identity, including projected siblings.
  const messages = options.nextMessages.map((message) => {
    const identity = nativeHistoryMessageIdentity(message);
    const held = identity ? previousByIdentity.get(identity)?.shift() : undefined;
    const source = nativeHistoryMessageSourceIdentity(message);
    if (!held && source && previousSources.has(source)) {
      changedSources.add(source);
    }
    return held ?? message;
  });
  const reconciled = { messages, pagination: options.nextPagination };
  if (!options.nextPagination.hasMore) {
    return reconciled;
  }
  const previousTotal = options.previousPagination.totalMessages;
  const nextTotal = options.nextPagination.totalMessages;
  if (previousTotal !== undefined && nextTotal !== undefined && nextTotal < previousTotal) {
    return reconciled;
  }
  const nextStart = retainedRawHistoryStart(options.nextPagination);
  const firstSource = nativeHistoryMessageSourceIdentity(messages[0]);
  const overlap = firstSource
    ? options.previousMessages.findIndex(
        (message) => nativeHistoryMessageSourceIdentity(message) === firstSource,
      )
    : options.previousMessages.indexOf(messages[0]);
  // Matching source IDs prove overlap without interpreting native sequences as
  // CLI ordinals. An empty visible window needs authoritative raw coverage;
  // a hidden page still advances the admitted oldest edge.
  const adjoining =
    typeof previousTotal === "number" &&
    nextStart !== null &&
    (options.previousMessages.length === 0
      ? nextStart <= previousTotal + 1
      : nextStart === previousTotal + 1);
  if (overlap < 0 && !adjoining) {
    return reconciled;
  }
  const prefix =
    overlap >= 0 ? options.previousMessages.slice(0, overlap) : options.previousMessages;
  const unavailable =
    options.previousPagination.hasMore &&
    !options.previousPagination.olderCursor &&
    !options.previousPagination.needsBoundary;
  // A missing edge never certified traversal. A fresh edge covers this tail
  // only; any older held prefix must reopen its own source boundary.
  if (unavailable && prefix.length === 0) {
    return reconciled;
  }
  const previousStart = retainedRawHistoryStart(options.previousPagination);
  const nextOffset =
    previousStart !== null && typeof nextTotal === "number"
      ? nextTotal - previousStart + 1
      : undefined;
  const replacedSources = new Set(
    options.previousMessages.slice(prefix.length).map(nativeHistoryMessageSourceIdentity),
  );
  // Reuse occurrence matching above: removed or changed tail rows revoke every
  // retained packet alias before refreshed bodies enter resident selection.
  for (const remaining of previousByIdentity.values()) {
    const source = nativeHistoryMessageSourceIdentity(remaining[0]);
    if (source && replacedSources.has(source)) {
      changedSources.add(source);
    }
  }
  return {
    messages: [...prefix, ...messages],
    retainedCoverage: true,
    pagination: {
      ...invalidateChatHistoryPacketSources(options.previousPagination, changedSources),
      ...(unavailable ? { needsBoundary: true as const } : {}),
      ...(nextTotal !== undefined ? { totalMessages: nextTotal } : {}),
      ...(options.previousPagination.hasMore && nextOffset !== undefined ? { nextOffset } : {}),
    },
  };
}

/** Each opaque edge certifies its own complete server response segment. */
export function extendChatHistoryWindow(
  previous: ChatHistoryPagination,
  previousMessages: readonly unknown[],
  incoming: readonly unknown[],
  pagination: ChatHistoryPagination,
  newerCursor: string | undefined,
  direction: "older" | "newer" | "tail",
  retainedCoverage?: ChatHistoryPagination,
  preparedPacket?: ChatHistorySegment,
): ChatHistoryPagination {
  const page = preparedPacket ?? prepareChatHistorySegment(incoming, pagination, newerCursor);
  if (direction === "tail" && !retainedCoverage) {
    return prepareChatHistoryTail(incoming, pagination, newerCursor, page);
  }
  const held = retainedCoverage?.segments ??
    previous.segments ?? [
      prepareChatHistorySegment(previousMessages, previous, previous.newerCursor),
    ];
  const known = new Set(held.flatMap((segment) => segment.sources));
  let segments: ChatHistorySegment[];
  if (direction !== "tail" && page.sources.every((source) => known.has(source))) {
    // Hidden/overlap-only traversal advances a raw edge, not a new body page.
    segments = [...held];
  } else if (direction === "tail") {
    const incomingSources = new Set(page.sources);
    const prefix = held
      .filter((segment) => segment.sources.some((source) => !incomingSources.has(source)))
      .map((segment) =>
        segment.hasNewer
          ? segment
          : Object.assign({}, segment, {
              hasNewer: true,
              newerCursor: undefined,
              boundedPacket: undefined,
            }),
      );
    // A refresh must not rewind a hidden-page edge just because its visible
    // prefix is empty. The reconciliation owner already proved continuity.
    segments = prefix.length
      ? [...prefix, page]
      : [
          {
            ...page,
            boundedPacket: undefined,
            hasOlder: previous.hasMore,
            olderCursor: previous.hasMore ? previous.olderCursor : undefined,
          },
        ];
  } else {
    let retained = held;
    if (page.sources.some((source) => known.has(source))) {
      const positions = new Map(page.sources.map((source, index) => [source, index] as const));
      const boundary =
        direction === "older"
          ? page.sources.findLastIndex((source) => !known.has(source))
          : page.sources.findIndex((source) => !known.has(source));
      // A live receipt can precede a hidden raw tail's anchor. Once this page
      // extends past it, retire its old alias so page eviction cannot leave an
      // isolated body. Ordinary boundary overlap still belongs to both pages.
      retained = held.map((segment) => {
        const sources = segment.sources.filter((source) => {
          const index = positions.get(source);
          return (
            index === undefined || (direction === "older" ? index >= boundary : index <= boundary)
          );
        });
        return sources.length === segment.sources.length
          ? segment
          : Object.assign({}, segment, { sources, boundedPacket: undefined });
      });
    }
    segments = direction === "older" ? [page, ...retained] : [...retained, page];
  }
  // Record this at authoritative admission, never by reselecting a different
  // oversized group during warm publication or reader movement.
  const intrinsicSource =
    intrinsicChatHistorySource(incoming) ??
    (direction !== "tail" || retainedCoverage ? previous.intrinsicSource : undefined);
  const coverage = {
    ...(direction === "tail" ? (retainedCoverage ?? pagination) : previous),
    ...(intrinsicSource ? { intrinsicSource } : {}),
    segments,
  };
  return direction === "tail"
    ? coverage
    : advanceChatHistoryNavigation(
        coverage,
        { ...pagination, ...(newerCursor ? { hasNewer: true as const, newerCursor } : {}) },
        direction,
      );
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
