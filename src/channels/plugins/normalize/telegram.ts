import { normalizeTelegramLookupTarget } from "../../../telegram/targets.js";

export function normalizeTelegramMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = normalizeTelegramLookupTarget(trimmed);
  if (!normalized) {
    // Keep legacy prefixed targets (including :topic: suffixes) valid.
    if (/^(telegram|tg):/i.test(trimmed)) {
      const stripped = trimmed.replace(/^(telegram|tg):/i, "").trim();
      if (stripped) {
        return `telegram:${stripped}`.toLowerCase();
      }
    }
    return undefined;
  }
  return `telegram:${normalized}`.toLowerCase();
}

export function looksLikeTelegramTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (normalizeTelegramLookupTarget(trimmed)) {
    return true;
  }
  return /^(telegram|tg):/i.test(trimmed);
}
