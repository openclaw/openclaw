import { solidContent } from "../lit/solid-content.tsx";
import { LegacyPluginThemeArtwork } from "./plugin-theme-artwork.tsx";

export function renderPluginThemeArtwork(url: string, className: string, fallback?: unknown) {
  return solidContent(LegacyPluginThemeArtwork, { url, class: className, fallback });
}
