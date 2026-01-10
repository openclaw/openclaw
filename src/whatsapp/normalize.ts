import { normalizeE164 } from "../utils.js";

function stripWhatsAppTargetPrefixes(value: string): string {
  let candidate = value.trim();
  for (;;) {
    const before = candidate;
    candidate = candidate
      .replace(/^whatsapp:/i, "")
      .replace(/^group:/i, "")
      .trim();
    if (candidate === before) return candidate;
  }
}

export function isWhatsAppGroupJid(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  const lower = candidate.toLowerCase();
  if (!lower.endsWith("@g.us")) return false;
  const localPart = candidate.slice(0, candidate.length - "@g.us".length);
  if (!localPart || localPart.includes("@")) return false;
  return /^[0-9]+(-[0-9]+)*$/.test(localPart);
}

export function normalizeWhatsAppTarget(value: string): string | null {
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (!candidate) return null;
  if (isWhatsAppGroupJid(candidate)) {
    const localPart = candidate.slice(0, candidate.length - "@g.us".length);
    return `${localPart}@g.us`;
  }
  const normalized = normalizeE164(candidate);
  return normalized.length > 1 ? normalized : null;
}
