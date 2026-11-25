import { createHash } from "node:crypto";
import type { SessionOrigin } from "../config/sessions/types.js";
import { matchesChannelAvatarSenderSource } from "../shared/channel-avatar-source.js";

/** Opaque revision; the stored media path never leaves the Gateway. */
export function channelAvatarRevision(reference: string): string {
  return createHash("sha256").update(reference).digest("base64url").slice(0, 12);
}

/** Transcript portraits bind the image snapshot as well as the exact native peer. */
export function matchesChannelAvatarSender(
  query: URLSearchParams,
  origin: SessionOrigin | undefined,
): boolean {
  if (!query.has("sender")) {
    return true;
  }
  return Boolean(
    origin?.avatar &&
    matchesChannelAvatarSenderSource(origin, {
      id: query.get("sender"),
      pluginId: query.get("provider"),
      accountId: query.get("account"),
    }) &&
    query.get("v") === channelAvatarRevision(origin.avatar),
  );
}
