export function normalizeKeybaseMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  let normalized = trimmed;
  if (normalized.toLowerCase().startsWith("keybase:")) {
    normalized = normalized.slice("keybase:".length).trim();
  }
  if (!normalized) {
    return undefined;
  }
  const lower = normalized.toLowerCase();
  if (lower.startsWith("team:")) {
    const id = normalized.slice("team:".length).trim();
    return id ? `team:${id}` : undefined;
  }
  // Plain username
  return normalized.toLowerCase();
}

const KEYBASE_USERNAME_PATTERN = /^[a-z_][a-z0-9_]{0,15}$/i;

export function looksLikeKeybaseTargetId(raw: string, normalized?: string): boolean {
  const candidates = [raw, normalized ?? ""].map((value) => value.trim()).filter(Boolean);

  for (const candidate of candidates) {
    if (/^(keybase:)?(team:)/i.test(candidate)) {
      return true;
    }
    const withoutPrefix = candidate.replace(/^keybase:/i, "").trim();
    if (KEYBASE_USERNAME_PATTERN.test(withoutPrefix)) {
      return true;
    }
  }

  return false;
}
