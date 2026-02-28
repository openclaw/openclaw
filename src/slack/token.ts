export function normalizeSlackToken(raw?: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveSlackBotToken(raw?: unknown): string | undefined {
  return normalizeSlackToken(raw);
}

export function resolveSlackAppToken(raw?: unknown): string | undefined {
  return normalizeSlackToken(raw);
}

export function resolveSlackUserToken(raw?: string): string | undefined {
  return normalizeSlackToken(raw);
}
