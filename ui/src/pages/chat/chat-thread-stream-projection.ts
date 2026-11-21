import type { ChatItem, ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import {
  insertionIndexesForBounds,
  type ChatProjection,
  type TurnInsertionBounds,
} from "./chat-thread-items.ts";
import { optionalBoundaryIdentity, optionalRunIdentity } from "./chat-thread-run-identity.ts";
import { buildToolStreamIdentity, extractToolMessageRefs } from "./tool-stream-identity.ts";

export function createStreamSegmentProjector(
  items: ChatItem[],
  projections: ChatProjection[],
  resolveBounds: (runId: unknown, afterUserSendId?: string) => TurnInsertionBounds | undefined,
) {
  return (
    segment: Pick<ChatStreamSegment, "ts" | "runId" | "afterUserSendId">,
    key: string,
    text: string,
    thinking?: string,
    beforeKey?: string,
  ) => {
    const bounds = resolveBounds(segment.runId, segment.afterUserSendId);
    let anchorKey = beforeKey;
    if (beforeKey) {
      const { minimum, maximum } = insertionIndexesForBounds(items, bounds);
      const beforeIndex = items.findIndex((item) => item.key === beforeKey);
      // A call anchor may tighten its input interval, never escape it.
      if (beforeIndex < minimum || beforeIndex >= maximum) {
        anchorKey = undefined;
      }
    }
    projections.push({
      item: {
        kind: "stream",
        key,
        text,
        ...(thinking ? { thinking } : {}),
        startedAt: segment.ts,
        isStreaming: false,
        ...optionalRunIdentity(segment.runId),
        ...optionalBoundaryIdentity(segment.runId),
      },
      bounds: anchorKey ? { ...bounds, beforeKey: anchorKey } : bounds,
    });
  };
}

export function createRecordedToolKeyLookup(items: Extract<ChatItem, { kind: "message" }>[]) {
  const keys = new Map<string, string>();
  // The invocation, not its later result, is the commentary's causal anchor.
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) {
      continue;
    }
    for (const ref of extractToolMessageRefs(item.message)) {
      if (ref.runId) {
        keys.set(buildToolStreamIdentity(ref.runId, ref.id), item.key);
      }
    }
  }
  return (runId: string | undefined, callId: string | undefined) =>
    runId && callId ? keys.get(buildToolStreamIdentity(runId, callId)) : undefined;
}
