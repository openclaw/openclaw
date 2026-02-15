export function resolveGmailRefreshToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
