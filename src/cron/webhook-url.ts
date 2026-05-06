function isAllowedWebhookProtocol(protocol: string) {
  return protocol === "http:" || protocol === "https:";
}

export function normalizeHttpWebhookUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (!isAllowedWebhookProtocol(parsed.protocol)) {
      return null;
    }
    // Do not allow embedded credentials in webhook URLs.
    if (parsed.username || parsed.password) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}
