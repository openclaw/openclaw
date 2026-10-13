import { readAssistantStreamSegmentIdentity } from "@openclaw/gateway-client/browser";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  streamSegmentHasItemId,
  streamSegmentUsesAccumulatedText,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import { streamCausalInterval, type StreamCausalBoundaryState } from "./stream-causal-boundary.ts";
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
      ? [{ ...segment, persisted: true as const }]
      : [];
  });
}

/** A durable commentary row immediately replaces its keyed live projection.
 * Waiting for terminal cleanup renders both copies throughout the active run. */
export function prunePersistedAssistantStreamSegments(
  state: StreamCausalBoundaryState,
  message: unknown,
): void {
  const identity = readAssistantStreamSegmentIdentity(message);
  if (!identity || !state.chatStreamSegments) {
    return;
  }
  const segments = state.chatStreamSegments.filter((segment) => {
    const runId = normalizeOptionalString(segment.runId);
    // Client-materialized commentary can be untagged; known run ownership
    // must still prevent a reused item id from pruning a sibling run.
    const sameRun = !identity.runId || !runId || identity.runId === runId;
    return normalizeOptionalString(segment.itemId) !== identity.itemId || !sameRun;
  });
  if (segments.length !== state.chatStreamSegments.length) {
    state.chatStreamSegments = segments;
  }
}

export function pruneHistoryReplacedStreamSegments(
  messages: unknown[],
  state: ToolStreamReconciliationState,
  opts: {
    isHiddenAssistantMessage: AssistantMessageVisibility;
    isHiddenStreamText: StreamVisibility;
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
    if (part.segmentIndex === undefined || part.itemId) {
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
      if (segment.persisted === true) {
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
