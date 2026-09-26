import {
  CONTROL_UI_BUILD_ID_ATTRIBUTE,
  type ControlUiRootPublicAsset,
} from "../../../src/gateway/control-ui-root-assets.js";
import { inferBasePathFromPathname, normalizeBasePath } from "../app-route-paths.ts";
import { resolveControlUiPaths } from "./browser.ts";

type ControlUiPublicAsset =
  | ControlUiRootPublicAsset
  | `fonts/${string}.css`
  | `themes/${string}.css`
  | `provider-icons/ProviderIcon-${string}.svg`
  | `cloud-provider-icons/${string}.svg`
  | `file-icons/${string}.svg`
  | `app-art/${string}.webp`
  | `community-art/${string}.webp`;

export function controlUiPublicAssetPath(
  asset: ControlUiPublicAsset,
  resourceBasePath: string | null | undefined,
): string {
  const buildId =
    asset !== "sw.js" && typeof document !== "undefined"
      ? document.documentElement.getAttribute(CONTROL_UI_BUILD_ID_ATTRIBUTE)
      : null;
  const version = buildId ? `?v=${encodeURIComponent(buildId)}` : "";
  return `${normalizeBasePath(resourceBasePath ?? "")}/${asset}${version}`;
}

export function inferControlUiPublicAssetPath(
  asset: ControlUiPublicAsset,
  params?: {
    resourceBasePath?: string | null;
    pathname?: string;
  },
): string {
  const resourceBasePath =
    params?.resourceBasePath ??
    (params?.pathname === undefined
      ? resolveControlUiPaths(typeof window === "undefined" ? "/" : window.location.pathname)[1]
      : inferBasePathFromPathname(params.pathname));
  return controlUiPublicAssetPath(asset, resourceBasePath);
}
