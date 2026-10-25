import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { ReplyReasoningVisibility } from "./reasoning-visibility.types.js";

// Only the producing host turn can register a policy for its opaque payload owner.
const visibilityByOwner = new WeakMap<object, (payload: ReplyPayload) => boolean>();

export function registerReplyReasoningVisibility(
  owner: ReplyReasoningVisibility,
  isVisible: (payload: ReplyPayload) => boolean,
): () => void {
  visibilityByOwner.set(owner, isVisible);
  return () => visibilityByOwner.delete(owner);
}

/** Bind durable reasoning to its producing turn across copies and queued delivery. */
export function bindReplyReasoningVisibility(
  payload: ReplyPayload,
  owner: ReplyReasoningVisibility | undefined,
): void {
  if (payload.isReasoning === true) {
    setReplyPayloadMetadata(payload, { reasoningVisibilityOwner: owner });
  }
}

/** A host-owned scalar read never retains the dispatch consumer's callback membrane. */
export function isReplyReasoningVisible(payload: ReplyPayload): boolean {
  const owner = getReplyPayloadMetadata(payload)?.reasoningVisibilityOwner;
  if (payload.isReasoning !== true || owner === undefined) {
    return false;
  }
  try {
    return visibilityByOwner.get(owner)?.(payload) === true;
  } catch {
    return false;
  }
}
