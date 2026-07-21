import { getReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";
import type { ReplyDispatchKind, ReplyDispatchRuntimeInfo } from "./reply-dispatcher.types.js";

export function buildReplyDispatchRuntimeInfo(
  payload: ReplyPayload,
  kind: ReplyDispatchKind,
  deliveryId: number,
): ReplyDispatchRuntimeInfo {
  const assistantMessageIndex = getReplyPayloadMetadata(payload)?.assistantMessageIndex;
  return {
    deliveryId,
    kind,
    ...(assistantMessageIndex !== undefined ? { assistantMessageIndex } : {}),
  };
}
