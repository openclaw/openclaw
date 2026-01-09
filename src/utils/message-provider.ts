export function normalizeMessageProvider(
  raw?: string | null,
): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "imsg") return "imessage";
  if (normalized === "teams") return "msteams";
  return normalized;
}

export function resolveMessageProvider(
  primary?: string | null,
  fallback?: string | null,
): string | undefined {
  return (
    normalizeMessageProvider(primary) ?? normalizeMessageProvider(fallback)
  );
}
