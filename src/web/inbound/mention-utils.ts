export type ParticipantMentionInfo = {
  jid: string;
  name?: string;
  notify?: string;
  phoneNumber?: string;
};

export function extractDigits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

export function normalizeMentionJid(jid: string): string {
  return jid.replace(/:\d+(?=@)/, "").replace(/@hosted\.lid$/, "@lid");
}

export function mentionUserPart(jid: string): string {
  return jid.split("@")[0] ?? "";
}

export function toPreferredParticipantMentionJid(
  participant: ParticipantMentionInfo,
): string | null {
  const phoneDigits = extractDigits(participant.phoneNumber);
  if (phoneDigits.length >= 6) {
    return `${phoneDigits}@s.whatsapp.net`;
  }
  const normalized = normalizeMentionJid(participant.jid);
  if (normalized.endsWith("@s.whatsapp.net") || normalized.endsWith("@lid")) {
    return normalized;
  }
  return null;
}
