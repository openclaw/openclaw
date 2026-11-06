import {
  reduceSessionProjection,
  type SessionProjectionState,
} from "@openclaw/gateway-client/browser";
import {
  nativeHistoryMessageSourceIdentity,
  nativeHistoryMessageSourceId,
} from "../../lib/chat/history-message-identity.ts";
import { clampText } from "../../lib/format.ts";
import {
  CHAT_RESIDENT_ENTRY_TARGET,
  CHAT_RESIDENT_WEIGHT_TARGET,
  messageWeight,
  sourceGroups,
  intrinsicGroup,
  prepareChatHistoryPinCost,
} from "./chat-history-cost.ts";
import { advanceChatHistoryNavigation } from "./chat-history-pagination.ts";
import type {
  ChatHistoryCursor,
  ChatHistoryPagination,
  ChatHistorySegment,
  ChatTranscriptReaderSnapshot,
} from "./chat-history-pagination.ts";
import {
  CHAT_HISTORY_REQUEST_LIMIT,
  CHAT_HISTORY_REQUEST_MAX_BYTES,
} from "./chat-history-request-params.ts";

export const MAX_RESIDENT_SEGMENTS = 8;

/** Body mutations revoke wire provenance without changing coverage or opaque edges. */
export function invalidateChatHistoryPacketSources(
  pagination: ChatHistoryPagination,
  sources: ReadonlySet<string>,
): ChatHistoryPagination {
  let changed = false;
  const segments = pagination.segments?.map((segment) => {
    if (!segment.boundedPacket || !segment.sources.some((source) => sources.has(source))) {
      return segment;
    }
    changed = true;
    return { ...segment, boundedPacket: undefined };
  });
  return changed ? { ...pagination, segments } : pagination;
}

function admitResidentLiveSources(
  initialPagination: ChatHistoryPagination,
  projection: SessionProjectionState,
): ChatHistoryPagination {
  if (!initialPagination.segments?.length) {
    return initialPagination;
  }
  const sourceEntries = projection.entries.map((entry) => ({
    entry,
    source: nativeHistoryMessageSourceIdentity(entry.message),
  }));
  // A source can gain fragments or replace its body without changing its name.
  // Revoke every overlapping packet, without turning flag-only changes into repartitioning.
  const pagination = invalidateChatHistoryPacketSources(
    initialPagination,
    new Set(
      sourceEntries.flatMap(({ entry, source }) =>
        source && (entry.live || entry.pending) ? [source] : [],
      ),
    ),
  );
  const segments = [...pagination.segments!];
  const owners = new Map(
    segments.flatMap((segment, index) => segment.sources.map((source) => [source, index] as const)),
  );
  const firstHeld = sourceEntries.findIndex(({ source }) => source !== null && owners.has(source));
  const lastHeld = sourceEntries.findLastIndex(
    ({ source }) => source !== null && owners.has(source),
  );
  let previousSource: string | null = null;
  let changed = false;
  for (const [index, { entry, source }] of sourceEntries.entries()) {
    if (source && owners.has(source)) {
      previousSource = source;
      continue;
    }
    // Live receipts can precede a stale tail. Admit only inside its certified
    // coverage; an evicted prefix or detached newer gap still needs a server page.
    if (
      !entry.live ||
      !source ||
      (segments[0]!.hasOlder && firstHeld >= 0 && index < firstHeld) ||
      (pagination.hasNewer && (lastHeld < 0 || index > lastHeld))
    ) {
      continue;
    }
    const owner = previousSource === null ? 0 : owners.get(previousSource)!;
    const segment = segments[owner]!;
    const sources = [...segment.sources];
    const insertion = previousSource === null ? 0 : sources.indexOf(previousSource) + 1;
    sources.splice(insertion, 0, source);
    segments[owner] = {
      ...segment,
      sources,
      boundedPacket: undefined,
      ...(segment.hasNewer && insertion === segment.sources.length
        ? { newerCursor: undefined }
        : {}),
    };
    owners.set(source, owner);
    previousSource = source;
    changed = true;
  }
  if (!changed) {
    return pagination;
  }
  const groups = sourceGroups(projection.messages);
  return {
    ...pagination,
    segments: segments.flatMap((segment, index) => {
      if (segment === pagination.segments![index]) {
        return [segment];
      }
      const chunks: string[][] = [[]];
      let count = 0;
      let weight = 1;
      for (const source of segment.sources) {
        const group = groups.get(source);
        if (
          chunks.at(-1)!.length &&
          (count + (group?.count ?? 0) > CHAT_HISTORY_REQUEST_LIMIT ||
            weight + (group?.weight ?? 0) > CHAT_HISTORY_REQUEST_MAX_BYTES)
        ) {
          chunks.push([]);
          count = 0;
          weight = 1;
        }
        chunks.at(-1)!.push(source);
        count += group?.count ?? 0;
        weight += group?.weight ?? 0;
      }
      return chunks.map((sources, chunk) => {
        const page: ChatHistorySegment = {
          sources,
          hasOlder: chunk === 0 ? segment.hasOlder : true,
          hasNewer: chunk === chunks.length - 1 ? segment.hasNewer : true,
        };
        if (chunk === 0 && segment.olderCursor) {
          page.olderCursor = segment.olderCursor;
        }
        if (chunk === chunks.length - 1 && segment.newerCursor) {
          page.newerCursor = segment.newerCursor;
        }
        return page;
      });
    }),
  };
}

/** Local text can be clipped; it must never borrow the intrinsic native-source exemption. */
export function boundChatLocalOutput<T extends { content: string }>(message: T): T {
  if (messageWeight(message) + 1 <= CHAT_RESIDENT_WEIGHT_TARGET) {
    return message;
  }
  let low = 0;
  let high = message.content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...message, content: clampText(message.content, middle) };
    if (messageWeight(candidate) + 1 <= CHAT_RESIDENT_WEIGHT_TARGET) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { ...message, content: clampText(message.content, low) };
}

export function prepareChatHistorySegment(
  messages: readonly unknown[],
  pagination: ChatHistoryPagination,
  newerCursor?: string,
): ChatHistorySegment {
  return {
    sources: [
      ...new Set(
        messages.flatMap((message) => {
          const source = nativeHistoryMessageSourceIdentity(message);
          // Prepare immutable body weights at admission, not on every stream delta.
          messageWeight(message);
          return source ? [source] : [];
        }),
      ),
    ],
    ...(pagination.hasMore && pagination.olderCursor
      ? { olderCursor: pagination.olderCursor }
      : {}),
    ...(newerCursor ? { newerCursor } : {}),
    hasOlder: pagination.hasMore,
    hasNewer: Boolean(pagination.hasNewer || newerCursor),
  };
}

/** Prepare immutable wire facts once, before tentative batch admission reuses them. */
export function prepareChatHistoryPacket(
  messages: readonly unknown[],
  pagination: ChatHistoryPagination,
  newerCursor?: string,
): ChatHistorySegment {
  const page = prepareChatHistorySegment(messages, pagination, newerCursor);
  if (
    page.sources.length <= CHAT_HISTORY_REQUEST_LIMIT &&
    new TextEncoder().encode(JSON.stringify(messages)).byteLength <= CHAT_HISTORY_REQUEST_MAX_BYTES
  ) {
    page.boundedPacket = true;
  }
  return page;
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
  const held = retainedCoverage?.segments ??
    previous.segments ?? [
      prepareChatHistorySegment(previousMessages, previous, previous.newerCursor),
    ];
  const known = new Set(held.flatMap((segment) => segment.sources));
  let segments: ChatHistorySegment[];
  if (direction !== "tail" && page.sources.every((source) => known.has(source))) {
    // Hidden/overlap-only traversal advances a raw edge, not a new body page.
    segments = [...held];
  } else if (direction === "tail" && retainedCoverage) {
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
    if (direction !== "tail" && page.sources.some((source) => known.has(source))) {
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
    segments =
      direction === "tail"
        ? [page]
        : direction === "older"
          ? [page, ...retained]
          : [...retained, page];
  }
  // Record this at authoritative admission, never by reselecting a different
  // oversized group during warm publication or reader movement.
  const intrinsicSource =
    [...sourceGroups(incoming)].findLast(([, group]) => intrinsicGroup(group))?.[0] ??
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
export function chatHistoryReaderBridge(
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

/** Bound the reloadable portion, then let the reducer preserve exact live pins. */
export function selectChatHistoryResidency(
  messages: readonly unknown[],
  pagination: ChatHistoryPagination,
  direction: "older" | "newer" | "tail" = "tail",
  readerSource?: string | null,
  localOutputs: readonly unknown[] = [],
  admission?: { visibleSources: readonly string[]; pins: readonly unknown[] },
): { messages: readonly unknown[]; pagination: ChatHistoryPagination; withinBudget: boolean } {
  if (!pagination.segments?.length && !localOutputs.length) {
    return { messages, pagination, withinBudget: true };
  }
  const pages = pagination.segments?.length
    ? pagination.segments
    : [prepareChatHistorySegment(messages, pagination, pagination.newerCursor)];
  const ordered = admission ? pages.flatMap((segment) => segment.sources) : [];
  const visible = new Set(admission?.visibleSources);
  const firstVisible = ordered.findIndex((source) => visible.has(source));
  const lastVisible = ordered.findLastIndex((source) => visible.has(source));
  const protectedSources = new Set(
    firstVisible < 0 ? [] : ordered.slice(firstVisible, lastVisible + 1),
  );
  const protectedSource = (source: string) =>
    source === readerSource || protectedSources.has(source);
  const ranges = pages.map((segment) => ({
    segment,
    start: 0,
    end: segment.sources.length,
    firstProtected: segment.sources.findIndex(protectedSource),
    lastProtected: segment.sources.findLastIndex(protectedSource),
    leftBlocked: false,
    rightBlocked: false,
  }));
  let firstRange = 0;
  let lastRange = ranges.length - 1;
  const protectsReader = (range: (typeof ranges)[number]) => range.firstProtected >= 0;
  const groups = sourceGroups(messages);
  const newestOutput = localOutputs.at(-1);
  const localCount = localOutputs.length ? 1 : 0;
  const localWeight = localOutputs.length ? messageWeight(newestOutput) : 0;
  const readerGroup = groups.get(readerSource ?? "");
  // One actual indivisible reader source can coexist with the newest charged
  // local outcome. Neither grants neighboring rows or older outputs a pin.
  const readerException =
    intrinsicGroup(readerGroup) ||
    Boolean(
      localCount &&
      readerGroup &&
      (readerGroup.count + localCount > CHAT_RESIDENT_ENTRY_TARGET ||
        readerGroup.weight + localWeight + 1 > CHAT_RESIDENT_WEIGHT_TARGET),
    );
  const intrinsicSource = intrinsicGroup(groups.get(pagination.intrinsicSource ?? ""))
    ? pagination.intrinsicSource
    : undefined;
  const readerPacket = ranges.find(
    ({ segment }) =>
      readerSource != null &&
      segment.sources.includes(readerSource) &&
      segment.boundedPacket &&
      !groups.get(readerSource)?.reopenable,
  );
  // Ordinary packets remain charged. Only the unavoidable over-budget packet
  // containing an unkeyed reader may retain its original opaque boundaries.
  const packetCost = readerPacket?.segment.sources.reduce(
    (cost, source) => {
      const group = groups.get(source);
      if (source !== intrinsicSource && !(source === readerSource && readerException)) {
        cost.count += group?.count ?? 0;
        cost.weight += group?.weight ?? 0;
      }
      return cost;
    },
    { count: 0, weight: 1 },
  );
  const packetException =
    packetCost &&
    (packetCost.count + localCount > CHAT_RESIDENT_ENTRY_TARGET ||
      packetCost.weight + localWeight > CHAT_RESIDENT_WEIGHT_TARGET)
      ? new Set(readerPacket!.segment.sources)
      : null;
  const memberships = new Map<string, number>();
  for (const page of pages) {
    for (const source of page.sources) {
      memberships.set(source, (memberships.get(source) ?? 0) + 1);
    }
  }
  const pinCost = prepareChatHistoryPinCost(messages, admission?.pins ?? []);
  const cost = { count: localCount + pinCost.count, weight: 1 + localWeight + pinCost.weight };
  let localOutputSource: string | undefined;
  const chargedGroup = (source: string) =>
    source === intrinsicSource ||
    source === localOutputSource ||
    (source === readerSource && readerException) ||
    packetException?.has(source)
      ? undefined
      : groups.get(source);
  const changeMembershipCost = (source: string, multiplier: number) => {
    const group = chargedGroup(source);
    const credit = pinCost.covered.get(source);
    cost.count += multiplier * ((group?.count ?? 0) - (credit?.count ?? 0));
    cost.weight += multiplier * ((group?.weight ?? 0) - (credit?.weight ?? 0));
  };
  for (const source of memberships.keys()) {
    changeMembershipCost(source, 1);
  }
  const release = (range: (typeof ranges)[number], start: number, end: number) => {
    for (let index = start; index < end; index++) {
      const source = range.segment.sources[index]!;
      const remaining = memberships.get(source)! - 1;
      if (remaining) {
        memberships.set(source, remaining);
      } else {
        memberships.delete(source);
        // Last coverage loss uncovers its pins; this can increase total cost.
        changeMembershipCost(source, -1);
      }
    }
  };
  const withinBudget = () =>
    lastRange - firstRange + 1 <= MAX_RESIDENT_SEGMENTS &&
    cost.count <= CHAT_RESIDENT_ENTRY_TARGET &&
    cost.weight <= CHAT_RESIDENT_WEIGHT_TARGET;
  let trimmed = false;
  const trimEnd = (fromRight: boolean) => {
    const range = ranges[fromRight ? lastRange : firstRange]!;
    const segment = range.segment;
    if (lastRange > firstRange && !protectsReader(range)) {
      release(range, range.start, range.end);
      const neighbor = ranges[fromRight ? --lastRange : ++firstRange]!;
      // Boundary-only changes preserve the stable reader-packet range and array.
      neighbor.segment = {
        ...neighbor.segment,
        ...(fromRight ? { hasNewer: true } : { hasOlder: true }),
      };
      return true;
    }
    if (range === readerPacket || (fromRight ? range.rightBlocked : range.leftBlocked)) {
      return false;
    }
    // Ranges only shrink and protected sources cannot leave. A failed end stays
    // blocked; successful scans and releases visit each source a bounded number of times.
    let cut = fromRight ? range.end - 2 : range.start + 1;
    for (; fromRight ? cut >= range.start : cut < range.end; cut += fromRight ? -1 : 1) {
      if (
        fromRight
          ? cut < range.lastProtected
          : range.firstProtected >= 0 && cut > range.firstProtected
      ) {
        break;
      }
      if (!groups.get(segment.sources[cut]!)?.reopenable) {
        continue;
      }
      if (fromRight) {
        release(range, cut + 1, range.end);
        range.end = cut + 1;
        range.segment = {
          ...segment,
          boundedPacket: undefined,
          hasNewer: true,
          newerCursor: undefined,
        };
      } else {
        release(range, range.start, cut);
        range.start = cut;
        range.segment = {
          ...segment,
          boundedPacket: undefined,
          hasOlder: true,
          olderCursor: undefined,
        };
      }
      return true;
    }
    if (fromRight) {
      range.rightBlocked = true;
    } else {
      range.leftBlocked = true;
    }
    return false;
  };
  while (!withinBudget()) {
    const fromRight =
      direction === "older" || (direction === "tail" && protectsReader(ranges[firstRange]!));
    if (!trimEnd(fromRight) && !trimEnd(!fromRight)) {
      // Only group charge is exempted for the final local pair. Its covered-pin
      // credit still applies, including when that contribution is negative.
      if (localCount && !localOutputSource && memberships.size === 1) {
        const source = memberships.keys().next().value!;
        const group = chargedGroup(source);
        cost.count -= group?.count ?? 0;
        cost.weight -= group?.weight ?? 0;
        localOutputSource = source;
        continue;
      }
      break;
    }
    trimmed = true;
  }
  const segments = ranges
    .slice(firstRange, lastRange + 1)
    .map(({ segment, start, end }) =>
      start === 0 && end === segment.sources.length
        ? segment
        : Object.assign({}, segment, { sources: segment.sources.slice(start, end) }),
    );
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  const retained = memberships;
  const admittedOutputs = new Set(localOutputs.length ? [newestOutput] : []);
  const outputCost = { ...cost };
  const localPair = Boolean(
    localOutputSource ||
    (readerException && !intrinsicGroup(readerGroup)) ||
    (packetException &&
      packetCost!.count <= CHAT_RESIDENT_ENTRY_TARGET &&
      packetCost!.weight <= CHAT_RESIDENT_WEIGHT_TARGET),
  );
  // Older outcomes use only spare ordinary capacity. They cannot block a new
  // page or spend an exemption needed only for the newest outcome/source pair.
  if (!localPair) {
    for (let index = localOutputs.length - 2; index >= 0; index--) {
      const output = localOutputs[index]!;
      const weight = messageWeight(output);
      if (
        outputCost.count + 1 > CHAT_RESIDENT_ENTRY_TARGET ||
        outputCost.weight + weight > CHAT_RESIDENT_WEIGHT_TARGET
      ) {
        continue;
      }
      admittedOutputs.add(output);
      outputCost.count += 1;
      outputCost.weight += weight;
    }
  }
  const admitted = messages.filter((message) => {
    const source = nativeHistoryMessageSourceIdentity(message);
    return admittedOutputs.has(message) || (source !== null && retained.has(source));
  });
  // Retain traversed edges only while their original outer source boundary survives.
  // A real cut/eviction instead reopens the surviving packet's own boundary.
  const older =
    firstRange === 0 && ranges[0]!.start === 0
      ? pagination
      : first.hasOlder
        ? {
            hasMore: true as const,
            olderCursor: first.olderCursor,
            needsBoundary: first.olderCursor ? undefined : (true as const),
          }
        : { hasMore: false as const };
  const newer =
    lastRange === pages.length - 1 && ranges[lastRange]!.end === pages[lastRange]!.sources.length
      ? pagination
      : {
          hasNewer: last.hasNewer ? (true as const) : undefined,
          newerCursor: last.newerCursor,
          needsNewerBoundary: last.hasNewer && !last.newerCursor ? (true as const) : undefined,
        };
  const nextPagination: ChatHistoryPagination = {
    ...(older.hasMore
      ? {
          hasMore: true as const,
          olderCursor: older.olderCursor,
          needsBoundary: older.needsBoundary,
        }
      : { hasMore: false as const }),
    ...(pagination.totalMessages !== undefined ? { totalMessages: pagination.totalMessages } : {}),
    ...(!trimmed &&
    !first.hasOlder &&
    !last.hasNewer &&
    !pagination.hasMore &&
    pagination.completeSnapshot
      ? { completeSnapshot: true as const }
      : {}),
    ...(!trimmed && pagination.hasMore && pagination.nextOffset !== undefined
      ? { nextOffset: pagination.nextOffset }
      : {}),
    ...(newer.hasNewer
      ? {
          hasNewer: true as const,
          newerCursor: newer.newerCursor,
          needsNewerBoundary: newer.needsNewerBoundary,
        }
      : {}),
    ...(intrinsicSource && retained.has(intrinsicSource) ? { intrinsicSource } : {}),
    segments,
  };
  return {
    messages: admitted,
    pagination: nextPagination,
    withinBudget: withinBudget(),
  };
}

/** Live/reader pins are not reloadable coverage and cannot lend a page edge. */
export function chatHistoryWindowBoundary(
  messages: readonly unknown[],
  pagination: ChatHistoryPagination,
  direction: "older" | "newer",
): unknown {
  const segment = direction === "older" ? pagination.segments?.[0] : pagination.segments?.at(-1);
  const source = direction === "older" ? segment?.sources[0] : segment?.sources.at(-1);
  return source
    ? messages.find((message) => nativeHistoryMessageSourceIdentity(message) === source)
    : direction === "older"
      ? messages.find((message) => nativeHistoryMessageSourceId(message) !== null)
      : messages.findLast((message) => nativeHistoryMessageSourceId(message) !== null);
}

/** Publication shares the page admission policy while retaining live/run pins. */
export function projectResidentChatHistory(
  projection: SessionProjectionState,
  pagination: ChatHistoryPagination,
  readerSource: string | null | undefined,
  pinnedRunId?: string | null,
) {
  const coverage = admitResidentLiveSources(pagination, projection);
  const admitted = selectChatHistoryResidency(
    projection.messages,
    coverage,
    "tail",
    readerSource,
    projection.entries.filter((entry) => entry.localOutput).map((entry) => entry.message),
  );
  return {
    projection: reduceSessionProjection(projection, {
      type: "residencyChanged",
      messages: admitted.messages,
      pinnedRunIds: pinnedRunId ? [pinnedRunId] : [],
    }),
    pagination: admitted.pagination,
  };
}

/** Retire secondary sources in the same synchronous publication as the visible array. */
export function publishResidentChatMessages(
  owner: {
    chatMessages: unknown[];
    transcriptMessagesRetired?: (messages: readonly unknown[]) => void;
  },
  previous: SessionProjectionState | undefined,
  projection: SessionProjectionState,
): void {
  if (
    owner.chatMessages.length !== projection.messages.length ||
    owner.chatMessages.some((message, index) => message !== projection.messages[index])
  ) {
    owner.chatMessages = [...projection.messages];
    // Dormant search, reply and attachment projections may still own old rows.
    // Retire their sources synchronously, even while their pane is hidden.
    const retained = new Set(projection.messages);
    const retired = previous?.messages.filter((message) => !retained.has(message));
    if (retired?.length) {
      owner.transcriptMessagesRetired?.(retired);
    }
  }
}

export type ChatHistoryResidencyOwner = {
  chatHistoryCursor?: ChatHistoryCursor;
  chatHistoryPagination?: ChatHistoryPagination;
  lastLocalTerminalReconcile?: { runId: string | null } | null;
  transcriptMessagesRetired?: (messages: readonly unknown[]) => void;
  readTranscriptReaderSnapshot?: () => ChatTranscriptReaderSnapshot | null;
};
