import { BROWSER_PAIR_ROUTE_PREFIX, type BrowserPairAction } from "../shared/browser-pair.js";

export function parseBrowserPairRequestPath(
  pathname: string,
  basePath: string,
): BrowserPairAction | null {
  const prefix = `${basePath}${BROWSER_PAIR_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const action = pathname.slice(prefix.length);
  return action === "start" || action === "collect" || action === "cancel" ? action : null;
}
