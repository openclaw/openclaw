import type {
  ThemeBranding,
  ThemeColorMode,
} from "../../../packages/gateway-protocol/src/theme.ts";

const BACKGROUND_PROPERTY = "--app-background-image";
let requestedUrl: string | undefined;

/**
 * Plugin canvas artwork replaces the palette's neutral image once its authenticated
 * bytes load. Every background surface reads the same token, so placement,
 * visibility, and accessibility fallbacks stay with their existing owners.
 */
export function syncThemeBackgroundArtwork(
  root: HTMLElement,
  branding: ThemeBranding,
  mode: ThemeColorMode,
): void {
  const url = branding.artwork?.backgrounds?.[mode]?.url;
  if (url === requestedUrl) {
    return;
  }
  requestedUrl = url;
  root.style.removeProperty(BACKGROUND_PROPERTY);
  if (!url) {
    return;
  }
  void import("../pages/plugins/icon-loader.ts")
    .then(({ fetchPluginThemeArtworkBlobUrl }) =>
      fetchPluginThemeArtworkBlobUrl({ url, background: true }),
    )
    .catch(() => null)
    .then((source) => {
      if (requestedUrl !== url) {
        return;
      }
      if (source) {
        root.style.setProperty(BACKGROUND_PROPERTY, `url("${source}")`);
      } else {
        // Neutral artwork stays visible; the next presentation change may retry.
        requestedUrl = undefined;
      }
    });
}
