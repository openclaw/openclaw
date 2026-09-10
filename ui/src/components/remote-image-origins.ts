/** Browser-side exact-origin check for Gateway-normalized remote image origins. */
export function isAllowedRemoteImageSource(
  source: string,
  remoteImageOrigins: readonly string[] | undefined,
): boolean {
  try {
    const url = new URL(source, globalThis.location.href);
    if (url.protocol === "data:" || url.protocol === "blob:") {
      return true;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    return (
      url.origin === globalThis.location.origin || (remoteImageOrigins ?? []).includes(url.origin)
    );
  } catch {
    return false;
  }
}
