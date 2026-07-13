import { copyReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import type { PluginHookReplyPayload } from "./hook-reply-payload.types.js";

/** Return a cloned plugin-visible payload without trusted-media metadata. */
export function toPluginReplyPayload(payload: ReplyPayload): PluginHookReplyPayload {
  const { trustedLocalMedia: _trustedLocalMedia, ...visiblePayload } = payload;
  return structuredClone(visiblePayload);
}

function mediaUrlsEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function preservesTrustedMediaRefs(previous: ReplyPayload, next: PluginHookReplyPayload): boolean {
  return (
    previous.trustedLocalMedia === true &&
    previous.mediaUrl === next.mediaUrl &&
    mediaUrlsEqual(previous.mediaUrls, next.mediaUrls)
  );
}

/** Accept plugin changes while preserving only unchanged trusted-media references. */
export function acceptPluginReplyPayload(
  previous: ReplyPayload,
  next: PluginHookReplyPayload,
): ReplyPayload {
  const { trustedLocalMedia: _trustedLocalMedia, ...safePayload } = next as ReplyPayload;
  const clonedPayload = structuredClone(safePayload);
  const acceptedPayload = preservesTrustedMediaRefs(previous, clonedPayload)
    ? { ...clonedPayload, trustedLocalMedia: true }
    : clonedPayload;
  return copyReplyPayloadMetadata(previous, acceptedPayload);
}
