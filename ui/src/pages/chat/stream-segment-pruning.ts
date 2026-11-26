import { readAssistantStreamSegmentIdentity } from "@openclaw/gateway-client/browser";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  streamSegmentUsesAccumulatedText,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import type { ToolStreamReconciliationState } from "./stream-reconciliation.ts";
import type { ToolStreamState } from "./tool-stream-contract.ts";
import {
  createSegmentToolRefReader,
  extractToolMessageRefs,
  resolveLiveToolStreamRefs,
  resolveMatchingLiveToolIdentity,
} from "./tool-stream-identity.ts";

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
  state: Pick<ToolStreamState, "chatStreamSegments">,
  message: unknown,
): void {
  const identity = readAssistantStreamSegmentIdentity(message);
  if (!identity) {
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

export function prunePersistedToolStreamMessages(
  state: ToolStreamReconciliationState,
  persistedToolIds: Set<string>,
) {
  if (persistedToolIds.size === 0) {
    return;
  }
  const liveToolRefs = resolveLiveToolStreamRefs(state);
  for (const id of persistedToolIds) {
    state.toolStreamById.delete(id);
  }
  state.toolStreamOrder = state.toolStreamOrder.filter((id) => !persistedToolIds.has(id));
  state.chatToolMessages = state.chatToolMessages.filter((message) => {
    const refs = extractToolMessageRefs(message);
    return refs.every((ref) => {
      const identity = resolveMatchingLiveToolIdentity(ref, liveToolRefs);
      return identity === undefined || !persistedToolIds.has(identity);
    });
  });
  const readToolRef = createSegmentToolRefReader(liveToolRefs);
  state.chatStreamSegments = pruneAccumulatedStreamSegments(
    state.chatStreamSegments,
    state.chatRunId,
    (segment) => {
      if (segment.persisted === true) {
        return false;
      }
      const { callId, runId, indexed } = readToolRef(segment);
      const toolIdentity = callId
        ? resolveMatchingLiveToolIdentity({ id: callId, runId }, liveToolRefs)
        : indexed?.identity;
      return Boolean(toolIdentity && persistedToolIds.has(toolIdentity));
    },
  );
}
