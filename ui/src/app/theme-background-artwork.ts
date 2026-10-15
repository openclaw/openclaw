import { DEFAULT_BACKGROUND_PREFERENCE } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
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
 *
 * Plugin images are untrusted like custom uploads, so the token carries the same
 * palette-derived dimming a default-strength upload gets: a theme-colored scrim
 * layer equals the upload's image opacity over the canvas underpaint.
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
  delete root.dataset.themeBackground;
  if (!url) {
    return;
  }
  void Promise.all([
    import("../pages/plugins/icon-loader.ts"),
    import("../components/session-background-contrast.ts"),
  ])
    .then(async ([{ fetchPluginThemeArtworkBlobUrl }, { readBackgroundOpacityLimit }]) => {
      const source = await fetchPluginThemeArtworkBlobUrl({ url, background: true });
      return source
        ? { source, opacity: readBackgroundOpacityLimit(root.ownerDocument.body ?? root) }
        : null;
    })
    .catch(() => null)
    .then((image) => {
      if (requestedUrl !== url) {
        return;
      }
      if (image) {
        root.style.setProperty(
          BACKGROUND_PROPERTY,
          dimmedBackgroundImage(image.source, image.opacity, mode),
        );
        root.dataset.themeBackground = "plugin";
      } else {
        // Neutral artwork stays visible; the next presentation change may retry.
        requestedUrl = undefined;
      }
    });
}

/** Same strength as a custom upload at default visibility (session-background owns that formula). */
function dimmedBackgroundImage(source: string, opacityLimit: number, mode: ThemeColorMode): string {
  const opacity =
    opacityLimit * DEFAULT_BACKGROUND_PREFERENCE.visibility * (mode === "light" ? 0.65 : 1);
  const scrim = `color-mix(in srgb, var(--bg-content, var(--bg)) ${Math.round((1 - opacity) * 1000) / 10}%, transparent)`;
  return `linear-gradient(${scrim}, ${scrim}), url("${source}")`;
}
