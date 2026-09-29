import {
  readAssistantStreamSegmentIdentity,
  readSessionMessageIdentity,
} from "@openclaw/gateway-client/browser";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { escapeRegExp } from "../../../../src/shared/regexp.js";
import { stripInlineDirectiveTagsForDelivery } from "../../../../src/utils/directive-tags.js";
import {
  accumulatedStreamText,
  advanceAccumulatedStreamText,
  streamSegmentHasItemId,
  streamSegmentUsesAccumulatedText,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import {
  streamCausalInterval,
  resolveCumulativeAssistantTail,
  type StreamCausalBoundaryState,
} from "./stream-causal-boundary.ts";
import {
  hasAssistantStreamPartReplacement,
  visibleAssistantStreamParts,
  type ToolStreamReconciliationState,
} from "./stream-reconciliation.ts";
import {
  extractToolMessageRefs,
  resolveLiveToolStreamRefs,
  resolveMatchingLiveToolIdentity,
} from "./tool-stream-identity.ts";

type AssistantMessageVisibility = (message: unknown) => boolean;
type StreamVisibility = (stream: string) => boolean;

function pruneAccumulatedStreamSegments(
  segments: readonly ChatStreamSegment[],
  activeRunId: string | null | undefined,
  shouldPrune: (segment: ChatStreamSegment, index: number) => boolean,
  retiredItemId?: string,
): ChatStreamSegment[] {
  return segments.flatMap((segment, index) => {
    if (!shouldPrune(segment, index)) {
      return [segment];
    }
    // Durable rows replace display, not the producer's cumulative baseline.
    // A segment owned by a different run than the active one has no future
    // deltas to trim, so retaining it would leak sibling-run state.
    const foreignRun = Boolean(segment.runId && activeRunId && segment.runId !== activeRunId);
    return !foreignRun && streamSegmentUsesAccumulatedText(segment)
      ? [{ ...segment, persisted: true as const, ...(retiredItemId ? { retiredItemId } : {}) }]
      : [];
  });
}

export function discardStreamSegmentIndexes(
  state: StreamCausalBoundaryState,
  discardedIndexes: readonly number[],
): void {
  if (!state.chatStreamSegments || discardedIndexes.length === 0) {
    return;
  }
  const discarded = new Set(discardedIndexes);
  state.chatStreamSegments = pruneAccumulatedStreamSegments(
    state.chatStreamSegments,
    state.chatRunId,
    (_segment, index) => discarded.has(index),
  );
}

export function reconcilePersistedAssistantStream(
  state: ToolStreamReconciliationState,
  replayedCommentaryItemId?: string,
  precedingItemText?: string,
): void {
  const runId = state.chatRunId;
  if (!runId) {
    return;
  }
  const replayCursors = new Map<number, number>();
  for (const segment of state.chatStreamSegments ?? []) {
    if (segment.runId !== runId || !segment.retiredItemId || !segment.pendingCommentary) {
      continue;
    }
    const pending = segment.pendingCommentary;
    const replayedItemDiffers =
      pending.replayItemId !== undefined && pending.replayItemId !== replayedCommentaryItemId;
    const unkeyedReplay =
      replayedCommentaryItemId === undefined &&
      precedingItemText === undefined &&
      state.chatStream !== null &&
      (!state.chatStreamItemId || state.chatStreamItemId === pending.replayItemId);
    const deliveredPrefix =
      precedingItemText === undefined || precedingItemText.length < pending.prefixLength
        ? undefined
        : stripInlineDirectiveTagsForDelivery(precedingItemText.slice(pending.prefixLength)).text;
    const replayCursor = replayCursors.get(pending.prefixLength) ?? 0;
    const remainingPrefix = deliveredPrefix?.slice(replayCursor);
    const replayedPrefix = remainingPrefix?.trimStart();
    const replayedRange =
      replayedPrefix === undefined ? undefined : commentaryRange(replayedPrefix, pending.text);
    const replayedBeforeCurrentItem = replayedItemDiffers && replayedRange?.start === 0;
    if (replayedItemDiffers && !replayedBeforeCurrentItem && !unkeyedReplay) {
      continue;
    }
    const leadingWhitespace = remainingPrefix
      ? remainingPrefix.length - remainingPrefix.trimStart().length
      : 0;
    if (replayedBeforeCurrentItem && replayCursor + leadingWhitespace > 0) {
      state.chatStreamSegments = state.chatStreamSegments?.map((owner) =>
        owner === segment && owner.pendingCommentary
          ? {
              ...owner,
              pendingCommentary: {
                ...owner.pendingCommentary,
                prefixLength: pending.prefixLength + replayCursor + leadingWhitespace,
              },
            }
          : owner,
      );
    }
    let handoff = retireCommentaryStream(state, {
      runId,
      itemId: segment.retiredItemId,
      text: segment.pendingCommentary.text,
      timestamp: segment.ts,
    });
    if (!handoff && replayedBeforeCurrentItem && precedingItemText && replayedRange) {
      const prefixEnd = pending.prefixLength + replayCursor + leadingWhitespace + replayedRange.end;
      retireCumulativePrefix(state, runId, precedingItemText.slice(0, prefixEnd), segment.ts, {
        itemId: segment.retiredItemId,
      });
      handoff = { text: pending.text };
    }
    if (handoff) {
      if (replayedBeforeCurrentItem && remainingPrefix && replayedRange) {
        const consumedLength = replayCursor + leadingWhitespace + replayedRange.end;
        replayCursors.set(pending.prefixLength, consumedLength);
        state.chatStreamSegments = state.chatStreamSegments?.map((owner) =>
          owner.retiredItemId !== segment.retiredItemId &&
          owner.pendingCommentary?.prefixLength === pending.prefixLength
            ? {
                ...owner,
                pendingCommentary: {
                  ...owner.pendingCommentary,
                  prefixLength: pending.prefixLength + consumedLength,
                },
              }
            : owner,
        );
      }
      state.chatStreamSegments = state.chatStreamSegments?.map((owner) =>
        owner.runId === runId && owner.itemId === segment.retiredItemId
          ? { ...owner, text: handoff.text }
          : owner,
      );
    }
  }
  const stream = state.chatStream ?? accumulatedStreamText(state.chatStreamSegments ?? []);
  if (!stream) {
    return;
  }
  const messages = (state.chatMessages ?? []).filter((message) => {
    const identity = readSessionMessageIdentity(message);
    return (
      identity?.role === "assistant" &&
      identity.id &&
      !identity.isImported &&
      identity.runId === runId &&
      !readAssistantStreamSegmentIdentity(message)
    );
  });
  const tail = resolveCumulativeAssistantTail(messages, stream, runId);
  const prefix = stream.slice(0, stream.length - (tail?.length ?? 0));
  if (!prefix) {
    return;
  }
  retireCumulativePrefix(state, runId, prefix, Date.now());
}

function retireCumulativePrefix(
  state: ToolStreamReconciliationState,
  runId: string,
  prefix: string,
  timestamp: number,
  retirement?: { itemId: string; segmentIndex?: number },
): void {
  const stream = state.chatStream ?? accumulatedStreamText(state.chatStreamSegments ?? []);
  let segments = state.chatStreamSegments ?? [];
  const accumulated = state.chatStream === null ? stream : accumulatedStreamText(segments);
  const shouldPrune = (segment: ChatStreamSegment, index: number) =>
    (!retirement || index === retirement.segmentIndex) &&
    segment.persisted !== true &&
    segment.runId === runId &&
    streamSegmentUsesAccumulatedText(segment) &&
    prefix.startsWith(segment.text);
  // Preserve renderer identity fast paths when persistence retires no segments.
  if (segments.some(shouldPrune)) {
    segments = pruneAccumulatedStreamSegments(segments, runId, shouldPrune, retirement?.itemId);
    state.chatStreamSegments = segments;
  }
  if (advanceAccumulatedStreamText(accumulated, prefix) === accumulated) {
    return;
  }
  // Persistence can overtake chat deltas. Retire only the observed cumulative
  // prefix; keep the received buffer intact so later deltas cannot restart it.
  const last = segments.at(-1);
  const extendsPersisted =
    last?.persisted &&
    last.runId === runId &&
    !last.boundaryRunId &&
    !last.toolCallId &&
    !last.retiredItemId &&
    !retirement;
  state.chatStreamSegments = [
    ...(extendsPersisted ? segments.slice(0, -1) : segments),
    {
      ...(extendsPersisted ? last : {}),
      text: prefix,
      ts: state.chatStreamStartedAt ?? timestamp,
      runId,
      persisted: true,
      ...(retirement ? { retiredItemId: retirement.itemId } : {}),
    },
  ];
}

function completePendingCommentary(
  state: ToolStreamReconciliationState,
  retired: ChatStreamSegment,
): { text: string } | null {
  const pending = retired.pendingCommentary;
  const stream = state.chatStream ?? accumulatedStreamText(state.chatStreamSegments ?? []);
  if (!pending || !stream?.startsWith(retired.text)) {
    return null;
  }
  const expectedText = pending.text;
  const rawTail = stream.slice(pending.prefixLength);
  const delivered = stripInlineDirectiveTagsForDelivery(rawTail).text;
  const projected = delivered.replace(/\s+/gu, " ").trim();
  let prefix = stream;
  let text = expectedText;
  let pendingCommentary: ChatStreamSegment["pendingCommentary"];
  if (expectedText.startsWith(projected) && projected !== expectedText) {
    pendingCommentary = { ...pending, text: expectedText };
  } else {
    // Match only this already-owned occurrence. A coalesced delta may also
    // contain new output, including another identical commentary paragraph.
    const pattern = expectedText.split(/\s+/u).map(escapeRegExp).join("\\s+");
    const match = new RegExp(`^\\s*${pattern}`, "u").exec(delivered);
    if (!match) {
      return null;
    }
    const suffix = delivered.slice(match[0].length).trimEnd();
    const source = rawTail.trimEnd();
    if (suffix && !source.endsWith(suffix)) {
      return null;
    }
    // A shorter item revision changes display, not bytes already owned by it.
    prefix = stream.slice(
      0,
      Math.max(retired.text.length, pending.prefixLength + source.length - suffix.length),
    );
    text = match[0].replace(/^(?:[ \t]*\r?\n)+/u, "").trimEnd();
  }
  state.chatStreamSegments = state.chatStreamSegments?.map((segment) => {
    if (segment === retired) {
      return { ...segment, text: prefix, pendingCommentary };
    }
    if (segment.pendingCommentaryPrefixFor === retired.retiredItemId) {
      return segment;
    }
    // A tool may have rolled the observed partial into another segment before
    // completion. It is the same cumulative occurrence, not new visible text.
    return segment.runId === retired.runId &&
      streamSegmentUsesAccumulatedText(segment) &&
      segment.text.startsWith(retired.text) &&
      prefix.startsWith(segment.text)
      ? { ...segment, persisted: true }
      : segment;
  });
  return { text };
}

/** Transfer one cumulative occurrence to its first keyed owner. */
export function retireCommentaryStream(
  state: ToolStreamReconciliationState,
  commentary: {
    runId: string;
    itemId: string;
    text: string;
    timestamp: number;
  },
): { text: string } | null {
  if (state.chatRunId !== commentary.runId) {
    return null;
  }
  const retired = state.chatStreamSegments?.find(
    (segment) => segment.runId === commentary.runId && segment.retiredItemId === commentary.itemId,
  );
  if (retired) {
    // Item revisions replace the expected text; only the observed cumulative
    // prefix must stay monotonic. Keep that update even while chat lags behind.
    const owner =
      retired.pendingCommentary && retired.pendingCommentary.text !== commentary.text
        ? { ...retired, pendingCommentary: { ...retired.pendingCommentary, text: commentary.text } }
        : retired;
    if (owner !== retired) {
      state.chatStreamSegments = state.chatStreamSegments?.map((segment) =>
        segment === retired ? owner : segment,
      );
    }
    return completePendingCommentary(state, owner);
  }
  // Only the first keyed event can acquire an unowned cumulative occurrence.
  // A later update without a pending retirement must not consume new output.
  if (
    state.chatStreamSegments?.some(
      (segment) => segment.runId === commentary.runId && segment.itemId === commentary.itemId,
    )
  ) {
    return null;
  }
  const part = visibleAssistantStreamParts(state, {
    includeCurrent: true,
    isHiddenStreamText: () => false,
  }).at(-1);
  if (!part || part.itemId || part.runId !== commentary.runId || part.boundaryRunId) {
    return null;
  }
  const preceding = (state.chatStreamSegments ?? []).slice(0, part.segmentIndex);
  const prefix = accumulatedStreamText(preceding);
  const rawTail =
    prefix && part.replacementText.startsWith(prefix)
      ? part.replacementText.slice(prefix.length)
      : part.replacementText;
  const text = stripInlineDirectiveTagsForDelivery(rawTail)
    .text.replace(/^(?:[ \t]*\r?\n)+/u, "")
    .trimEnd();
  // The preamble producer flattens whitespace. Keep the cumulative formatting
  // when that exact projection identifies the same complete occurrence.
  const projectedText = text.replace(/\s+/gu, " ").trim();
  if (!text || (text !== commentary.text && projectedText !== commentary.text)) {
    if (!projectedText || !commentary.text.startsWith(projectedText)) {
      return null;
    }
    // Retire observed bytes immediately. Keep completion with the cumulative
    // owner so replacing the keyed display with history cannot lose the handoff.
    retireCumulativePrefix(state, commentary.runId, part.replacementText, commentary.timestamp, {
      itemId: commentary.itemId,
      segmentIndex: part.segmentIndex,
    });
    state.chatStreamSegments = state.chatStreamSegments?.map((segment) =>
      segment.runId === commentary.runId && segment.retiredItemId === commentary.itemId
        ? {
            ...segment,
            pendingCommentary: { text: commentary.text, prefixLength: prefix?.length ?? 0 },
          }
        : segment,
    );
    return { text: commentary.text };
  }
  retireCumulativePrefix(state, commentary.runId, part.replacementText, commentary.timestamp, {
    itemId: commentary.itemId,
    segmentIndex: part.segmentIndex,
  });
  return { text };
}

function commentaryRange(precedingItemText: string, commentaryText: string) {
  const intraItemWhitespace = "(?:[^\\S\\r\\n]+|[^\\S\\r\\n]*\\r?\\n[^\\S\\r\\n]*)";
  const pattern = commentaryText
    .trim()
    .split(/(\s+)/u)
    .map((part, index) => {
      if (index % 2 === 0) {
        return escapeRegExp(part);
      }
      const lineBreaks = part.match(/\r?\n/gu)?.length ?? 0;
      return lineBreaks >= 2 ? "(?:[^\\S\\r\\n]*\\r?\\n){2,}[^\\S\\r\\n]*" : intraItemWhitespace;
    })
    .join("");
  const content = precedingItemText.trimEnd();
  const matches = [
    ...content.matchAll(new RegExp(`(?:^|(?:\\r?\\n){2})(${pattern})(?=(?:\\r?\\n){2}|$)`, "gu")),
  ];
  if (matches.length !== 1) {
    return undefined;
  }
  const match = matches[0];
  const matchedText = match?.[1];
  if (!match || !matchedText) {
    return undefined;
  }
  const start = match.index + match[0].length - matchedText.length;
  return { start, end: start + matchedText.length, content };
}

function precedingCommentaryStart(precedingItemText: string, commentaryText: string) {
  const range = commentaryRange(precedingItemText, commentaryText);
  return range && range.end === range.content.length ? range.start : undefined;
}

function retirePrecedingCommentary(
  state: ToolStreamReconciliationState,
  commentary: { runId: string; itemId: string; text: string; timestamp: number },
  precedingItemText: string,
): boolean {
  const knownOwner = state.chatStreamSegments?.findLast(
    (segment) =>
      segment.runId === commentary.runId &&
      segment.persisted !== true &&
      normalizeOptionalString(segment.itemId) !== undefined &&
      precedingCommentaryStart(precedingItemText, segment.text) !== undefined,
  );
  if (!knownOwner?.itemId || knownOwner.itemId !== commentary.itemId) {
    return false;
  }
  const range = commentaryRange(precedingItemText, commentary.text);
  if (!range) {
    return false;
  }
  const visiblePrefix = precedingItemText.slice(0, range.start);
  const accumulated = accumulatedStreamText(state.chatStreamSegments ?? []);
  if (visiblePrefix && advanceAccumulatedStreamText(accumulated, visiblePrefix) !== accumulated) {
    state.chatStreamSegments = [
      ...(state.chatStreamSegments ?? []),
      {
        text: visiblePrefix,
        ts: state.chatStreamStartedAt ?? commentary.timestamp,
        runId: commentary.runId,
      },
    ];
  }
  const retiredPrefix = precedingItemText.slice(0, range.end);
  retireCumulativePrefix(state, commentary.runId, retiredPrefix, commentary.timestamp, {
    itemId: commentary.itemId,
  });
  if (range.end < range.content.length) {
    state.chatStreamSegments = [
      ...(state.chatStreamSegments ?? []),
      {
        text: precedingItemText,
        ts: state.chatStreamStartedAt ?? commentary.timestamp,
        runId: commentary.runId,
      },
    ];
  }
  return true;
}

/** A durable commentary row immediately replaces its keyed live projection.
 * Waiting for terminal cleanup renders both copies throughout the active run. */
export function prunePersistedAssistantStreamSegments(
  state: ToolStreamReconciliationState,
  message: unknown,
): void {
  const identity = readAssistantStreamSegmentIdentity(message);
  if (!identity || !state.chatStreamSegments) {
    return;
  }
  const replacedIndexes = state.chatStreamSegments.flatMap((segment, index) => {
    const runId = normalizeOptionalString(segment.runId);
    // Client-materialized commentary can be untagged; known run ownership
    // must still prevent a reused item id from pruning a sibling run.
    const sameRun = !identity.runId || !runId || identity.runId === runId;
    return normalizeOptionalString(segment.itemId) === identity.itemId && sameRun ? [index] : [];
  });
  if (replacedIndexes.length === 0) {
    const runId = identity.runId ?? state.chatRunId;
    const text = extractTextCached(message);
    if (
      runId &&
      runId === state.chatRunId &&
      text &&
      !state.chatStreamSegments.some(
        (segment) => segment.runId === runId && segment.retiredItemId === identity.itemId,
      )
    ) {
      if (
        state.chatStreamItemId === identity.itemId &&
        state.chatStreamItemStartOffset !== undefined
      ) {
        const stream = state.chatStream ?? "";
        const prefix = stream.slice(0, state.chatStreamItemStartOffset);
        const accumulated = accumulatedStreamText(state.chatStreamSegments);
        if (prefix && advanceAccumulatedStreamText(accumulated, prefix) !== accumulated) {
          state.chatStreamSegments = [
            ...state.chatStreamSegments,
            {
              text: prefix,
              ts: state.chatStreamStartedAt ?? Date.now(),
              runId,
              pendingCommentaryPrefixFor: identity.itemId,
            },
          ];
        }
        const handoff = retireCommentaryStream(state, {
          runId,
          itemId: identity.itemId,
          text,
          timestamp: Date.now(),
        });
        if (handoff) {
          return;
        }
      }
      if (
        state.chatStreamItemId &&
        state.chatStreamItemId !== identity.itemId &&
        state.chatStreamItemStartOffset !== undefined &&
        retirePrecedingCommentary(
          state,
          { runId, itemId: identity.itemId, text, timestamp: Date.now() },
          (state.chatStream ?? "").slice(0, state.chatStreamItemStartOffset),
        )
      ) {
        return;
      }
      const accumulated = accumulatedStreamText(state.chatStreamSegments);
      const baseline = state.chatStream ?? accumulated ?? "";
      const segments =
        baseline && advanceAccumulatedStreamText(accumulated, baseline) !== accumulated
          ? [
              ...state.chatStreamSegments,
              {
                text: baseline,
                ts: state.chatStreamStartedAt ?? Date.now(),
                runId,
                pendingCommentaryPrefixFor: identity.itemId,
              },
            ]
          : state.chatStreamSegments;
      // Persistence arrived before this commentary occurrence reached the
      // cumulative chat stream. Roll the observed prefix into its own visible
      // segment, then keep a one-occurrence receipt anchored after that prefix.
      state.chatStreamSegments = [
        ...segments,
        {
          text: baseline,
          ts: Date.now(),
          runId,
          persisted: true,
          retiredItemId: identity.itemId,
          pendingCommentary: {
            text,
            prefixLength: baseline.length,
            replayItemId: identity.itemId,
          },
        },
      ];
    }
    return;
  }
  discardStreamSegmentIndexes(state, replacedIndexes);
}

export function pruneHistoryReplacedStreamSegments(
  messages: unknown[],
  state: ToolStreamReconciliationState,
  opts: {
    isHiddenAssistantMessage: AssistantMessageVisibility;
    isHiddenStreamText: StreamVisibility;
    persistCommentary?: boolean;
  },
): boolean {
  if (!Array.isArray(state.chatStreamSegments)) {
    return false;
  }
  const replacedIndexes = new Set<number>();
  for (const part of visibleAssistantStreamParts(state, {
    includeCurrent: false,
    isHiddenStreamText: opts.isHiddenStreamText,
  })) {
    if (part.segmentIndex === undefined || (part.itemId && opts.persistCommentary !== true)) {
      continue;
    }
    const interval = streamCausalInterval(messages, part);
    if (
      hasAssistantStreamPartReplacement(
        messages,
        part,
        opts.isHiddenAssistantMessage,
        interval.start,
        interval.end,
      )
    ) {
      replacedIndexes.add(part.segmentIndex);
    }
  }
  if (replacedIndexes.size === 0) {
    return false;
  }
  state.chatStreamSegments = pruneAccumulatedStreamSegments(
    state.chatStreamSegments,
    state.chatRunId,
    (_segment, index) => replacedIndexes.has(index),
  );
  return true;
}

export function prunePersistedToolStreamMessages(
  state: ToolStreamReconciliationState,
  persistedToolIds: Set<string>,
) {
  if (persistedToolIds.size === 0) {
    return;
  }
  const liveToolRefs = resolveLiveToolStreamRefs(state);
  if (state.toolStreamById instanceof Map) {
    for (const id of persistedToolIds) {
      state.toolStreamById.delete(id);
    }
  }
  if (Array.isArray(state.toolStreamOrder)) {
    state.toolStreamOrder = state.toolStreamOrder.filter(
      (id): id is string => typeof id === "string" && !persistedToolIds.has(id),
    );
  }
  if (Array.isArray(state.chatToolMessages)) {
    state.chatToolMessages = state.chatToolMessages.filter((message) => {
      const refs = extractToolMessageRefs(message);
      return refs.every((ref) => {
        const identity = resolveMatchingLiveToolIdentity(ref, liveToolRefs);
        return identity === undefined || !persistedToolIds.has(identity);
      });
    });
  }
  if (!Array.isArray(state.chatStreamSegments)) {
    return;
  }
  let toolIndexedSegmentIndex = 0;
  state.chatStreamSegments = pruneAccumulatedStreamSegments(
    state.chatStreamSegments,
    state.chatRunId,
    (segment) => {
      if (segment.boundaryMarker === true || segment.persisted === true) {
        return false;
      }
      const explicitToolCallId = normalizeOptionalString(segment.toolCallId);
      const usesItemId = streamSegmentHasItemId(segment);
      const indexedToolRef = usesItemId ? undefined : liveToolRefs[toolIndexedSegmentIndex];
      if (!usesItemId) {
        toolIndexedSegmentIndex += 1;
      }
      const segmentRunId = normalizeOptionalString(segment.runId);
      const toolIdentity = explicitToolCallId
        ? resolveMatchingLiveToolIdentity(
            {
              id: explicitToolCallId,
              ...(segmentRunId ? { runId: segmentRunId } : {}),
            },
            liveToolRefs,
          )
        : indexedToolRef?.identity;
      return Boolean(toolIdentity && persistedToolIds.has(toolIdentity));
    },
  );
}
