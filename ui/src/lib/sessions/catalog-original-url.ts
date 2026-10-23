/** Catalog links open another site, never continue an adopted read-only session. */
export function resolveCatalogOriginalUrl(value: string | undefined): string | undefined {
  if (!value || !/^https?:\/\//.test(value) || /[\s\\?#]/.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
