import { normalizeTelegramLookupTarget } from "../../../telegram/targets.js";

export function normalizeTelegramMessagingTarget(raw: string): string | undefined {
  const normalized = normalizeTelegramLookupTarget(raw);
  if (!normalized) {
    return undefined;
  }
  return `telegram:${normalized}`.toLowerCase();
}

export function looksLikeTelegramTargetId(raw: string): boolean {
  return Boolean(normalizeTelegramLookupTarget(raw));
}
