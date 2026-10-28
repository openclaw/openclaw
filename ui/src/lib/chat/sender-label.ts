import { asOptionalRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString as normalizeLabelPart } from "@openclaw/normalization-core/string-coerce";
import type { SessionParticipantIdentity } from "../../../../packages/gateway-protocol/src/schema/session-participant.js";
import { readTranscriptSenderIdentity } from "../../../../src/chat/sender-identity.js";

// Keep legacy labels readable without treating their UUID suffix as profile evidence.
const OPAQUE_ID_LABEL_SUFFIX_RE =
  /\s+\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/iu;

export type SenderIdentity = {
  identity?: SessionParticipantIdentity;
  id?: string;
  name?: string;
  username?: string;
  profileAvatarUrl?: string;
};

type SenderIdentityInput = {
  identity?: unknown;
  id?: unknown;
  name?: unknown;
  username?: unknown;
  profileAvatarUrl?: unknown;
};

/** Formats durable sender identity without assuming ids will always be email addresses. */
export function formatSenderLabel(sender: SenderIdentity | null | undefined): string | null {
  const displayName = normalizeLabelPart(sender?.name) ?? normalizeLabelPart(sender?.username);
  if (displayName) {
    return displayName;
  }
  const id = normalizeLabelPart(sender?.id);
  if (!id) {
    return null;
  }
  return /^([^@\s]+)@[^@\s]+$/.exec(id)?.[1] ?? id;
}

export function normalizeSenderIdentity(
  sender: SenderIdentityInput | null | undefined,
): SenderIdentity | null {
  const id = normalizeLabelPart(sender?.id);
  const name = normalizeLabelPart(sender?.name);
  const username = normalizeLabelPart(sender?.username);
  const profileAvatarUrl = normalizeLabelPart(sender?.profileAvatarUrl);
  const identity = readTranscriptSenderIdentity(sender?.identity);
  if (!id && !name && !username && !profileAvatarUrl) {
    return null;
  }
  return {
    ...(identity ? { identity } : {}),
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(username ? { username } : {}),
    ...(profileAvatarUrl ? { profileAvatarUrl } : {}),
  };
}

export function resolveMessageSender(
  metadata: Record<string, unknown> | undefined,
): SenderIdentity | null {
  const identity = readTranscriptSenderIdentity(metadata?.senderIdentity);
  return normalizeSenderIdentity({
    identity,
    id: metadata?.senderId,
    name: metadata?.senderName,
    username: metadata?.senderUsername,
    profileAvatarUrl: identity?.type === "profile" ? metadata?.senderProfileAvatarUrl : undefined,
  });
}

export function resolveMessageSenderLabel(
  message: unknown,
  sender?: SenderIdentity | null,
): string | null {
  const m = asOptionalRecord(message);
  const rawLabel = readStringField(m, "senderLabel")?.trim() ?? "";
  if (rawLabel) {
    return rawLabel.replace(OPAQUE_ID_LABEL_SUFFIX_RE, "").trim();
  }
  // Full normalization already prepared the sender; null is a known absence.
  return formatSenderLabel(
    sender === undefined ? resolveMessageSender(asOptionalRecord(m?.["__openclaw"])) : sender,
  );
}

export function senderIdentityKey(sender: SenderIdentity | null | undefined): string | null {
  if (!sender) {
    return null;
  }
  if (sender.identity) {
    return sessionParticipantIdentityKey(sender.identity);
  }
  return [
    sender.id ?? "",
    sender.name ?? "",
    sender.username ?? "",
    sender.profileAvatarUrl ?? "",
  ].join("\u0000");
}

/** Keys a participant identity by its fields, so key order never splits one person. */
export function sessionParticipantIdentityKey(identity: SessionParticipantIdentity): string {
  return JSON.stringify(identity, Object.keys(identity).toSorted());
}

/**
 * Keys the signed-in viewer, the author of local messages that carry no sender
 * metadata. Without a profile the viewer is still one distinct person.
 */
export function localParticipantIdentityKey(userId: string | null | undefined): string {
  return userId
    ? sessionParticipantIdentityKey({ type: "profile", id: userId })
    : JSON.stringify(["local"]);
}
