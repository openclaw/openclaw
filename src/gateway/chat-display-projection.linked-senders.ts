import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { decodeRequesterOrigin } from "../agents/requester-origin.js";
import { readTranscriptSenderIdentity } from "../chat/sender-identity.js";
import type { CurrentUserProfileDisplay } from "./current-user-profile-display.js";

export type LinkedChannelSenderDisplay = Extract<CurrentUserProfileDisplay, { kind: "resolved" }>;
export type LinkedChannelSenderDisplayResolver = (
  message: unknown,
) => LinkedChannelSenderDisplay | undefined;

// Internal projection passes may revisit a sanitized copy. This symbol survives
// object spreads but not JSON or worker transfer, and is valid only for the same
// prepared read. It carries display data, never requester or authorization facts.
const linkedDisplayProjection = Symbol("linked-channel-display-projection");
type DisplayMetadata = Record<string, unknown> & {
  [linkedDisplayProjection]?: {
    resolver: LinkedChannelSenderDisplayResolver;
    display: LinkedChannelSenderDisplay;
  };
};

export function readLinkedChannelSenderCandidate(value: unknown) {
  const message = asOptionalRecord(value);
  const metadata = asOptionalRecord(message?.["__openclaw"]);
  const identity = readTranscriptSenderIdentity(metadata?.senderIdentity);
  const origin = decodeRequesterOrigin(metadata?.requesterOrigin);
  const provenance = asOptionalRecord(message?.provenance);
  if (
    message?.role !== "user" ||
    message.display === false ||
    (provenance && provenance.kind !== "external_user") ||
    identity?.type !== "observation" ||
    identity.senderKind !== "human" ||
    !identity.pluginId ||
    !identity.accountId ||
    !origin?.operatorProfileId ||
    origin.operatorProfileId === GATEWAY_OWNER_PROFILE_ID
  ) {
    return undefined;
  }
  return {
    profileId: origin.operatorProfileId,
    identity: {
      channelId: identity.pluginId,
      accountId: identity.accountId,
      senderId: identity.id,
    },
  };
}

/** Shared fanout defers this viewer-facing association to an authorized history read. */
export function requiresLinkedChannelSenderDisplayRead(message: unknown): boolean {
  return readLinkedChannelSenderCandidate(message) !== undefined;
}

/** Derive before sanitation removes private requester evidence; never alter source identity. */
export function projectLinkedChannelSenderDisplay(
  message: unknown,
  resolveDisplay?: LinkedChannelSenderDisplayResolver,
): unknown {
  const record = asOptionalRecord(message);
  const metadata: DisplayMetadata | undefined = asOptionalRecord(record?.["__openclaw"]);
  if (!record || !metadata) {
    return message;
  }
  const retained = metadata[linkedDisplayProjection];
  const display =
    resolveDisplay?.(message) ??
    (resolveDisplay && retained?.resolver === resolveDisplay ? retained.display : undefined);
  if (!display && !("senderDisplayProfileId" in metadata) && !("senderDisplayName" in metadata)) {
    return message;
  }
  const projected = { ...metadata };
  delete projected[linkedDisplayProjection];
  delete projected.senderDisplayProfileId;
  delete projected.senderDisplayName;
  if (readTranscriptSenderIdentity(metadata.senderIdentity)?.type === "observation") {
    delete projected.senderProfileAvatarUrl;
  }
  if (display && resolveDisplay) {
    projected[linkedDisplayProjection] = { resolver: resolveDisplay, display };
    projected.senderDisplayProfileId = display.profileId;
    projected.senderDisplayName = display.label;
    projected.senderProfileAvatarUrl = display.avatarUrl;
  }
  return { ...record, __openclaw: projected };
}
