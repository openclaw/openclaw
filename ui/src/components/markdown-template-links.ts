import { templateCatalogPackageNameFromPath } from "../app-route-paths.ts";
import { resolveControlUiPaths } from "../app/browser.ts";

/** Local catalog links retain a useful route when opened outside the chat surface. */
export function markdownTemplatePackage(raw: string, basePath?: string): string | null {
  const location = globalThis.location;
  if (!location) {
    return null;
  }
  const url = URL.parse(raw, location.href);
  if (!url || url.origin !== location.origin || url.search || url.hash) {
    return null;
  }
  return templateCatalogPackageNameFromPath(
    url.pathname,
    basePath ?? resolveControlUiPaths(location.pathname)[0],
  );
}
