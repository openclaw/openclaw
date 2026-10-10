/** Exact HTTPS admission for ordinary message Markdown images. */
export function isAllowedRemoteImageSource(
  source: string,
  remoteImageOrigins: readonly string[] | undefined,
): boolean {
  try {
    const url = new URL(source);
    return url.protocol === "https:" && (remoteImageOrigins ?? []).includes(url.origin);
  } catch {
    return false;
  }
}
