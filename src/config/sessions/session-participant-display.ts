import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  participantIdentityNamespace,
  type SessionParticipantIdentity,
} from "./session-participant-identity.js";

export type ChannelParticipantDisplayInput = { label?: string; profileId?: string };
/** Keys include the complete channel namespace. Only retained contributions have entries. */
export type SessionParticipantDisplay = Record<string, ChannelParticipantDisplayInput>;

export function channelParticipantDisplayKey(identity: SessionParticipantIdentity): string {
  return JSON.stringify([participantIdentityNamespace(identity), identity.id]);
}

/** Return a replacement only when the roster changes. A prior unknown or differently linked
 * contribution cannot be retroactively attributed to the most recent profile. */
export function mergeChannelParticipantDisplay(
  current: SessionParticipantDisplay | undefined,
  identity: SessionParticipantIdentity,
  observed: ChannelParticipantDisplayInput | undefined,
  promptedAt: number,
  previous: { lastPromptedAt: number | null } | undefined,
): SessionParticipantDisplay | undefined {
  if (identity.type !== "remote" && identity.type !== "observation") {
    return undefined;
  }
  const key = channelParticipantDisplayKey(identity);
  const old = current?.[key];
  const incoming = truncateUtf16Safe(observed?.label?.trim() ?? "", 200);
  const label =
    incoming && (!old?.label || promptedAt >= (previous?.lastPromptedAt ?? 0))
      ? incoming
      : old?.label;
  const profileId =
    !previous || old?.profileId === observed?.profileId ? observed?.profileId : undefined;
  if (old?.label === label && old?.profileId === profileId) {
    return undefined;
  }
  return { ...current, [key]: { ...(label && { label }), ...(profileId && { profileId }) } };
}
