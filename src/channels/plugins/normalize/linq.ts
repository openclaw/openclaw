import { normalizeLinqHandle } from "../../../linq/targets.js";

export function normalizeLinqMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  // Strip linq: prefix if present
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("linq:")) {
    const remainder = trimmed.slice(5).trim();
    const normalized = normalizeLinqHandle(remainder);
    return normalized ? `linq:${normalized}` : undefined;
  }

  const normalized = normalizeLinqHandle(trimmed);
  return normalized || undefined;
}

export function looksLikeLinqTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^linq:/i.test(trimmed)) {
    return true;
  }
  if (trimmed.includes("@")) {
    return true;
  }
  // E.164 phone number
  return /^\+?\d{3,}$/.test(trimmed);
}
