import { copyReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import {
  collectReplyMediaEntries,
  recordReplyPayloadMediaSelectionChange,
} from "../infra/outbound/reply-media-entries.js";
import type { PluginHookReplyPayload } from "./hook-types.js";

export const toPluginReplyPayload = (payload: ReplyPayload): PluginHookReplyPayload => {
  const { trustedLocalMedia: _trustedLocalMedia, ...visiblePayload } = payload;
  return structuredClone(visiblePayload);
};
const areMediaUrlArraysEqual = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean => {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
};
const preservesTrustedMediaRefs = (
  previous: ReplyPayload,
  next: PluginHookReplyPayload,
): boolean => {
  return (
    previous.trustedLocalMedia === true &&
    previous.mediaUrl === next.mediaUrl &&
    areMediaUrlArraysEqual(previous.mediaUrls, next.mediaUrls)
  );
};
export const acceptPluginReplyPayload = (
  previous: ReplyPayload,
  next: PluginHookReplyPayload,
): ReplyPayload => {
  // SAFETY: the optional core-only field is viewed solely to discard it, never to trust it.
  const { trustedLocalMedia: _trustedLocalMedia, ...safePayload } = next as ReplyPayload;
  const clonedPayload = structuredClone(safePayload);
  const acceptedPayload = preservesTrustedMediaRefs(previous, clonedPayload)
    ? { ...clonedPayload, trustedLocalMedia: true }
    : clonedPayload;
  return recordReplyPayloadMediaSelectionChange(
    collectReplyMediaEntries(previous).map(({ url }) => url),
    copyReplyPayloadMetadata(previous, acceptedPayload),
  );
};
