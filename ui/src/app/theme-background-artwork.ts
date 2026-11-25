import { DEFAULT_BACKGROUND_PREFERENCE } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type {
  ThemeBranding,
  ThemeColorMode,
} from "../../../packages/gateway-protocol/src/theme.ts";
import { BACKGROUND_IMAGE_OPACITY_CAP } from "../components/session-background-opacity.ts";

const BACKGROUND_PROPERTY = "--app-background-image";
let requestedUrl: string | undefined;
let loaded: { url: string; source: string; opacityLimit: number } | undefined;

/**
 * Plugin canvas artwork replaces the palette's neutral image once its authenticated
 * bytes load. Every background surface reads the same token, so placement,
 * visibility, and accessibility fallbacks stay with their existing owners.
 *
 * Plugin images are untrusted like custom uploads, so the token carries the same
 * palette-derived dimming a default-strength upload gets: a theme-colored scrim
 * layer equals the upload's image opacity over the canvas underpaint. Above the
 * default visibility the viewer has asked for more than the palette-safe strength,
 * so the scrim thins toward the shared cap every upload already stops at.
 */
export function syncThemeBackgroundArtwork(
  root: HTMLElement,
  branding: ThemeBranding,
  mode: ThemeColorMode,
  visibility: number = DEFAULT_BACKGROUND_PREFERENCE.visibility,
): void {
  const url = branding.artwork?.backgrounds?.[mode]?.url;
  if (url === requestedUrl) {
    if (loaded && loaded.url === url) {
      paint(root, loaded.source, loaded.opacityLimit, mode, visibility);
    }
    return;
  }
  requestedUrl = url;
  loaded = undefined;
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
        loaded = { url, source: image.source, opacityLimit: image.opacity };
        paint(root, image.source, image.opacity, mode, visibility);
      } else {
        // Neutral artwork stays visible; the next presentation change may retry.
        requestedUrl = undefined;
      }
    });
}

/**
 * At or below default visibility: the same strength as a custom upload at default
 * visibility (session-background owns that formula). Above it, a linear lift from
 * that palette-safe strength to the shared cap, reached at full visibility.
 */
function paint(
  root: HTMLElement,
  source: string,
  opacityLimit: number,
  mode: ThemeColorMode,
  visibility: number,
): void {
  const safe = opacityLimit * DEFAULT_BACKGROUND_PREFERENCE.visibility;
  const lift = Math.min(
    1,
    Math.max(0, visibility - DEFAULT_BACKGROUND_PREFERENCE.visibility) /
      (1 - DEFAULT_BACKGROUND_PREFERENCE.visibility),
  );
  const strength = safe + Math.max(0, BACKGROUND_IMAGE_OPACITY_CAP - safe) * lift;
  const opacity = strength * (mode === "light" ? 0.65 : 1);
  const scrim = `color-mix(in srgb, var(--bg-content, var(--bg)) ${Math.round((1 - opacity) * 1000) / 10}%, transparent)`;
  root.style.setProperty(
    BACKGROUND_PROPERTY,
    `linear-gradient(${scrim}, ${scrim}), url("${source}")`,
  );
  root.dataset.themeBackground = "plugin";
}
