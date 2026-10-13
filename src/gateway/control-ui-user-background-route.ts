import { isBackgroundAssetId } from "../../packages/gateway-protocol/src/schema/background-preferences.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";

const PREFIX = "/__openclaw__/users/background/";
export function buildControlUiUserBackgroundPath(
  assetId: string,
  basePath?: string | null,
): string {
  return `${normalizeControlUiBasePath(basePath)}${PREFIX}${encodeURIComponent(assetId)}`;
}
export function parseControlUiUserBackgroundPath(pathname: string, basePath?: string) {
  const base = normalizeControlUiBasePath(basePath);
  const path = base && pathname.startsWith(base + PREFIX) ? pathname.slice(base.length) : pathname;
  if (!path.startsWith(PREFIX)) {
    return { matched: false as const };
  }
  const assetId = path.slice(PREFIX.length);
  return { matched: true as const, assetId: isBackgroundAssetId(assetId) ? assetId : undefined };
}
