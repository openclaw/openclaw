import {
  isBuiltinThemeId,
  isThemeId,
  normalizeThemeMode,
  type BuiltinThemeId,
  type ThemeId,
  type ThemeMode,
} from "../../../packages/gateway-protocol/src/theme-ids.ts";
import { inferControlUiPublicAssetPath } from "./public-assets.ts";
export type ThemeName = ThemeId | "custom";
export type { ThemeMode };
type ThemeFamily = Exclude<BuiltinThemeId, "claw" | "knot"> | "openknot" | "custom";
export type ResolvedTheme = "dark" | "light" | ThemeFamily | `${ThemeFamily}-light`;

function prefersLightScheme(): boolean {
  if (typeof globalThis.matchMedia !== "function") {
    return false;
  }
  return globalThis.matchMedia("(prefers-color-scheme: light)").matches;
}

export function parseThemeSelection(
  themeRaw: unknown,
  modeRaw: unknown,
): { theme: ThemeName; mode: ThemeMode } {
  const normalizedTheme = themeRaw === "custom" || isThemeId(themeRaw) ? themeRaw : "claw";
  const normalizedMode = normalizeThemeMode(modeRaw) ?? "system";

  return { theme: normalizedTheme, mode: normalizedMode };
}

function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return prefersLightScheme() ? "light" : "dark";
  }
  return mode;
}

export function resolveTheme(theme: ThemeName, mode: ThemeMode): ResolvedTheme {
  const resolvedMode = resolveMode(mode);
  if (theme === "claw") {
    return resolvedMode;
  }
  const family = !isBuiltinThemeId(theme) ? "custom" : theme === "knot" ? "openknot" : theme;
  return resolvedMode === "light" ? `${family}-light` : family;
}

/** Publish theme colors only after their stylesheet is available. */
export function syncThemePaletteStylesheet(theme: ThemeName, ready: () => void): void {
  if (typeof document === "undefined" || theme === "claw" || !isBuiltinThemeId(theme)) {
    ready();
    return;
  }
  // Retain the six built-in families once visited. Their exclusive selectors
  // leave the previous theme intact during loading and make repeat switches synchronous.
  const id = `openclaw-theme-palette-${theme}`;
  const existing = document.getElementById(id);
  if (existing instanceof HTMLLinkElement && existing.sheet) {
    ready();
    return;
  }
  const link = existing instanceof HTMLLinkElement ? existing : document.createElement("link");
  const finish = (event: Event) => {
    link.removeEventListener("load", finish);
    link.removeEventListener("error", finish);
    if (event.type === "error") {
      // Failed assets must not strand startup; normal CSS defaults stay readable.
      // Remove the failed link so a later selection can retry rather than wait forever.
      console.error(`Theme palette failed to load; reload to retry: ${link.href}`);
      link.remove();
    }
    ready();
  };
  link.addEventListener("load", finish);
  link.addEventListener("error", finish);
  if (!existing) {
    link.id = id;
    link.rel = "stylesheet";
    link.href = inferControlUiPublicAssetPath(`themes/${theme}.css`);
    document.head.append(link);
  }
}
