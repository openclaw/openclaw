export type TelegramReactionSemanticsCollision = {
  normalizedKey: string;
  firstRawKey: string;
  duplicateRawKey: string;
};

export type TelegramReactionSemanticsInvalidKey = {
  rawKey: string;
};

const TELEGRAM_REACTION_EMOJI_SHORTHAND_PATTERN =
  /^(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*)$/u;
const TELEGRAM_CUSTOM_EMOJI_ID_PATTERN = /^\d+$/;

export function normalizeTelegramReactionKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const parts = /^([a-z_]+):(.*)$/i.exec(trimmed);
  if (!parts) {
    return TELEGRAM_REACTION_EMOJI_SHORTHAND_PATTERN.test(trimmed) ? `emoji:${trimmed}` : null;
  }

  const prefix = parts[1]?.toLowerCase();
  const value = parts[2]?.trim();
  if (!value) {
    return null;
  }

  if (prefix === "emoji") {
    return TELEGRAM_REACTION_EMOJI_SHORTHAND_PATTERN.test(value) ? `emoji:${value}` : null;
  }

  if (prefix === "custom_emoji") {
    return TELEGRAM_CUSTOM_EMOJI_ID_PATTERN.test(value) ? `custom_emoji:${value}` : null;
  }

  return null;
}

export function findTelegramReactionSemanticsCollisions(
  semantics?: Record<string, unknown> | null,
): TelegramReactionSemanticsCollision[] {
  if (!semantics) {
    return [];
  }

  const seen = new Map<string, string>();
  const collisions: TelegramReactionSemanticsCollision[] = [];
  for (const rawKey of Object.keys(semantics)) {
    const normalizedKey = normalizeTelegramReactionKey(rawKey);
    if (!normalizedKey) {
      continue;
    }

    const firstRawKey = seen.get(normalizedKey);
    if (!firstRawKey) {
      seen.set(normalizedKey, rawKey);
      continue;
    }

    if (firstRawKey !== rawKey) {
      collisions.push({
        normalizedKey,
        firstRawKey,
        duplicateRawKey: rawKey,
      });
    }
  }

  return collisions;
}

export function findInvalidTelegramReactionSemanticsKeys(
  semantics?: Record<string, unknown> | null,
): TelegramReactionSemanticsInvalidKey[] {
  if (!semantics) {
    return [];
  }

  const invalidKeys: TelegramReactionSemanticsInvalidKey[] = [];
  for (const rawKey of Object.keys(semantics)) {
    if (!normalizeTelegramReactionKey(rawKey)) {
      invalidKeys.push({ rawKey });
    }
  }

  return invalidKeys;
}
